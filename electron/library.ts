import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseFile } from "music-metadata";

const AUDIO_EXTENSIONS = new Set([".aac", ".aif", ".aiff", ".alac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".wma"]);
const COVER_NAMES = ["cover.jpg", "cover.jpeg", "cover.png", "folder.jpg", "folder.png", "front.jpg", "front.png"];
const MUSICBRAINZ_USER_AGENT = "RecordShelf/0.6.6 (desktop-music-player)";
const MAX_ARTWORK_BYTES = 15 * 1024 * 1024;

export type ScanProgress = { phase: "discovering" | "reading" | "finishing"; current: number; total: number; file?: string };
export type ArtworkProgress = { current: number; total: number; album: string; status: "searching" | "found" | "missing" | "error" };
export type Track = { id: number; albumId: string; path: string; title: string; artist: string; album: string; albumArtist: string; trackNumber: number; discNumber: number; duration: number; year: number | null; genres: string[] };
export type Album = { id: string; title: string; artist: string; year: number | null; artworkUrl: string | null; artworkSource: "embedded" | "folder" | "musicbrainz" | null; tracks: Track[] };
export type Artist = { name: string; imageUrl: string | null; imageSource: "wikimedia" | null };
export type Playlist = { id: string; name: string; trackIds: number[] };
export type ArtworkResult = { success: boolean; message: string; albumId: string };
type Row = Record<string, unknown>;

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const fetchWithTimeout = (input: string | URL, init: RequestInit = {}) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) });
const normalise = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const escapeLucene = (value: string) => value.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, "\\$1");
const normaliseGenres = (values: readonly string[] | undefined): string[] => {
  const genres: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    for (const part of value.split(/[;,]/)) {
      const genre = part.trim();
      const key = genre.toLocaleLowerCase();
      if (genre && !seen.has(key)) { seen.add(key); genres.push(genre); }
    }
  }
  return genres;
};
const parseGenres = (value: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? normaliseGenres(parsed.filter((item): item is string => typeof item === "string")) : [];
  } catch { return []; }
};

export class MusicLibrary {
  private readonly db: DatabaseSync;
  private readonly artworkDirectory: string;
  private musicBrainzQueue: Promise<void> = Promise.resolve();
  private lastMusicBrainzRequest = 0;
  private genreMetadataReady = false;

  constructor(databasePath: string, artworkDirectory: string) {
    this.db = new DatabaseSync(databasePath);
    this.artworkDirectory = artworkDirectory;
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS albums (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, year INTEGER, artwork_path TEXT,
        artwork_source TEXT, artwork_updated_at INTEGER NOT NULL DEFAULT 0, musicbrainz_id TEXT
      );
      CREATE TABLE IF NOT EXISTS tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, source_root TEXT NOT NULL,
        relative_path TEXT,
        album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE, title TEXT NOT NULL, artist TEXT NOT NULL,
        album TEXT NOT NULL, album_artist TEXT NOT NULL, track_number INTEGER NOT NULL DEFAULT 0,
        disc_number INTEGER NOT NULL DEFAULT 0, duration REAL NOT NULL DEFAULT 0, year INTEGER,
        genres TEXT NOT NULL DEFAULT '[]',
        modified_ms REAL NOT NULL, scan_token TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tracks_album_id ON tracks(album_id);
      CREATE INDEX IF NOT EXISTS tracks_source_root ON tracks(source_root);
      CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS artist_images (
        name TEXT PRIMARY KEY COLLATE NOCASE, image_path TEXT NOT NULL, image_source TEXT NOT NULL,
        image_updated_at INTEGER NOT NULL DEFAULT 0, musicbrainz_id TEXT
      );
      CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, position INTEGER NOT NULL,
        PRIMARY KEY (playlist_id, position)
      );
    `);
    this.ensureAlbumColumn("artwork_source", "TEXT");
    this.ensureAlbumColumn("artwork_updated_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureAlbumColumn("musicbrainz_id", "TEXT");
    this.ensureTrackColumn("genres", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureTrackColumn("relative_path", "TEXT");
    this.migrateRelativePaths();
    const genreVersion = this.db.prepare("SELECT value FROM settings WHERE key = 'genre_metadata_version'").get() as Row | undefined;
    this.genreMetadataReady = genreVersion?.value === "1";
  }

  private migrateRelativePaths(): void {
    const rows = this.db.prepare("SELECT id, path, source_root FROM tracks WHERE relative_path IS NULL OR relative_path = ''").all() as Row[];
    const update = this.db.prepare("UPDATE tracks SET relative_path = ? WHERE id = ?");
    for (const row of rows) {
      const relative = path.relative(String(row.source_root), String(row.path));
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) update.run(relative, Number(row.id));
    }
  }

  private ensureAlbumColumn(name: string, definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(albums)").all() as Row[];
    if (!columns.some((column) => column.name === name)) this.db.exec(`ALTER TABLE albums ADD COLUMN ${name} ${definition}`);
  }

  private ensureTrackColumn(name: string, definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(tracks)").all() as Row[];
    if (!columns.some((column) => column.name === name)) this.db.exec(`ALTER TABLE tracks ADD COLUMN ${name} ${definition}`);
  }

  getLibraryRoot(): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'library_root'").get() as Row | undefined;
    return row ? String(row.value) : null;
  }

  getTrackPath(id: number): string | null {
    const row = this.db.prepare("SELECT path, relative_path FROM tracks WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    const root = this.getLibraryRoot();
    return root && row.relative_path ? path.join(root, String(row.relative_path)) : String(row.path);
  }

  setLibraryRoot(root: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('library_root', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(root);
  }

  getArtworkPath(albumId: string): string | null {
    const row = this.db.prepare("SELECT artwork_path FROM albums WHERE id = ?").get(albumId) as Row | undefined;
    return row?.artwork_path ? String(row.artwork_path) : null;
  }

  getArtistImagePath(name: string): string | null {
    const row = this.db.prepare("SELECT image_path FROM artist_images WHERE name = ? COLLATE NOCASE").get(name) as Row | undefined;
    return row?.image_path ? String(row.image_path) : null;
  }

  snapshot(): { root: string | null; albums: Album[]; artists: Artist[]; playlists: Playlist[] } {
    const albumRows = this.db.prepare("SELECT * FROM albums ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE").all() as Row[];
    const trackRows = this.db.prepare(`SELECT id, album_id, path, title, artist, album, album_artist, track_number, disc_number, duration, year, genres FROM tracks ORDER BY album_artist COLLATE NOCASE, album COLLATE NOCASE, disc_number, track_number, title COLLATE NOCASE`).all() as Row[];
    const tracksByAlbum = new Map<string, Track[]>();
    for (const row of trackRows) {
      const albumId = String(row.album_id);
      const track: Track = {
        id: Number(row.id), albumId, path: String(row.path), title: String(row.title), artist: String(row.artist),
        album: String(row.album), albumArtist: String(row.album_artist), trackNumber: Number(row.track_number),
        discNumber: Number(row.disc_number), duration: Number(row.duration), year: row.year == null ? null : Number(row.year),
        genres: parseGenres(row.genres),
      };
      const list = tracksByAlbum.get(albumId) ?? [];
      list.push(track);
      tracksByAlbum.set(albumId, list);
    }
    const albums = albumRows.map((row): Album => ({
      id: String(row.id), title: String(row.title), artist: String(row.artist), year: row.year == null ? null : Number(row.year),
      artworkUrl: row.artwork_path ? `music-art://cover/${encodeURIComponent(String(row.id))}?v=${Number(row.artwork_updated_at ?? 0)}` : null,
      artworkSource: (row.artwork_source as Album["artworkSource"]) ?? null,
      tracks: tracksByAlbum.get(String(row.id)) ?? [],
    })).filter((album) => album.tracks.length > 0);
    const artistImageRows = this.db.prepare("SELECT name, image_path, image_source, image_updated_at FROM artist_images").all() as Row[];
    const imagesByArtist = new Map(artistImageRows.map((row) => [String(row.name).toLocaleLowerCase(), row]));
    const artists = Array.from(new Set(albums.map((album) => album.artist))).sort((left, right) => left.localeCompare(right)).map((name): Artist => {
      const image = imagesByArtist.get(name.toLocaleLowerCase());
      return {
        name,
        imageUrl: image?.image_path ? `music-art://artist/${encodeURIComponent(name)}?v=${Number(image.image_updated_at ?? 0)}` : null,
        imageSource: image?.image_source === "wikimedia" ? "wikimedia" : null,
      };
    });

    const playlistRows = this.db.prepare("SELECT id, name FROM playlists ORDER BY name COLLATE NOCASE").all() as Row[];
    const playlistTracks = this.db.prepare("SELECT playlist_id, track_id FROM playlist_tracks ORDER BY position").all() as Row[];
    const idsByPlaylist = new Map<string, number[]>();
    for (const row of playlistTracks) {
      const id = String(row.playlist_id);
      const list = idsByPlaylist.get(id) ?? [];
      list.push(Number(row.track_id));
      idsByPlaylist.set(id, list);
    }
    return { root: this.getLibraryRoot(), albums, artists, playlists: playlistRows.map((row) => ({ id: String(row.id), name: String(row.name), trackIds: idsByPlaylist.get(String(row.id)) ?? [] })) };
  }

  createPlaylist(name: string): Playlist {
    const id = randomUUID();
    const cleanName = name.trim() || "Untitled Playlist";
    this.db.prepare("INSERT INTO playlists (id, name) VALUES (?, ?)").run(id, cleanName);
    return { id, name: cleanName, trackIds: [] };
  }

  deletePlaylist(playlistId: string): void {
    this.db.prepare("DELETE FROM playlists WHERE id = ?").run(playlistId);
  }

  addToPlaylist(playlistId: string, trackId: number): void {
    if (this.db.prepare("SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?").get(playlistId, trackId)) return;
    const positionRow = this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM playlist_tracks WHERE playlist_id = ?").get(playlistId) as Row;
    this.db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)").run(playlistId, trackId, Number(positionRow.next));
  }

  removeFromPlaylist(playlistId: string, trackId: number): void {
    this.db.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?").run(playlistId, trackId);
  }

  async scan(root: string, onProgress: (progress: ScanProgress) => void): Promise<void> {
    const rootStat = await stat(root).catch(() => null);
    if (!rootStat?.isDirectory()) throw new Error("The music folder is unavailable. Your existing catalogue was left unchanged.");
    const scanToken = randomUUID();
    await mkdir(this.artworkDirectory, { recursive: true });
    onProgress({ phase: "discovering", current: 0, total: 0 });
    const files = await this.findAudioFiles(root);
    const existingCount = this.db.prepare("SELECT COUNT(*) AS count FROM tracks").get() as Row;
    if (files.length === 0 && Number(existingCount.count) > 0) throw new Error("No audio files were visible on the share. The existing catalogue was retained in case the NAS is temporarily unavailable.");

    const existingFile = this.db.prepare("SELECT id, modified_ms, album_id, path FROM tracks WHERE path = ?");
    const existingRelative = this.db.prepare("SELECT id, modified_ms, album_id, path FROM tracks WHERE relative_path = ? LIMIT 1");
    const markUnchanged = this.db.prepare("UPDATE tracks SET scan_token = ?, source_root = ?, path = ?, relative_path = ? WHERE id = ?");
    const relocateTrack = this.db.prepare("UPDATE tracks SET path = ?, source_root = ?, relative_path = ? WHERE id = ?");
    const updateLocalArtwork = this.db.prepare("UPDATE albums SET artwork_path = ?, artwork_source = ?, artwork_updated_at = ? WHERE id = ?");
    const upsertAlbum = this.db.prepare(`
      INSERT INTO albums (id, title, artist, year, artwork_path, artwork_source, artwork_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, artist = excluded.artist,
        year = COALESCE(excluded.year, albums.year), artwork_path = COALESCE(excluded.artwork_path, albums.artwork_path),
        artwork_source = CASE WHEN excluded.artwork_path IS NOT NULL THEN excluded.artwork_source ELSE albums.artwork_source END,
        artwork_updated_at = CASE WHEN excluded.artwork_path IS NOT NULL THEN excluded.artwork_updated_at ELSE albums.artwork_updated_at END
    `);
    const upsertTrack = this.db.prepare(`
      INSERT INTO tracks (path, source_root, relative_path, album_id, title, artist, album, album_artist, track_number, disc_number, duration, year, genres, modified_ms, scan_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET album_id = excluded.album_id, title = excluded.title, artist = excluded.artist,
        album = excluded.album, album_artist = excluded.album_artist, track_number = excluded.track_number,
        disc_number = excluded.disc_number, duration = excluded.duration, year = excluded.year, genres = excluded.genres,
        modified_ms = excluded.modified_ms, scan_token = excluded.scan_token, source_root = excluded.source_root,
        relative_path = excluded.relative_path
    `);
    const artworkFound = new Set<string>();
    const artworkChecked = new Set<string>();
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      onProgress({ phase: "reading", current: index + 1, total: files.length, file: path.basename(file) });
      try {
        const fileStat = await stat(file);
        const relativePath = path.relative(root, file);
        const existing = (existingFile.get(file) ?? existingRelative.get(relativePath)) as Row | undefined;
        if (existing && this.genreMetadataReady && Math.abs(Number(existing.modified_ms) - fileStat.mtimeMs) < 1) {
          const existingId = existing.id ?? (this.db.prepare("SELECT id FROM tracks WHERE path = ?").get(file) as Row | undefined)?.id;
          if (existingId) markUnchanged.run(scanToken, root, file, relativePath, Number(existingId));
          const existingAlbumId = existing.album_id ? String(existing.album_id) : null;
          if (existingAlbumId && !artworkChecked.has(existingAlbumId) && !this.getArtworkPath(existingAlbumId)) {
            artworkChecked.add(existingAlbumId);
            const artwork = await this.cacheArtwork(existingAlbumId, file);
            if (artwork) updateLocalArtwork.run(artwork.path, artwork.source, Date.now(), existingAlbumId);
          }
          continue;
        }
        if (existing?.id && String(existing.path) !== file) relocateTrack.run(file, root, relativePath, Number(existing.id));
        const metadata = await parseFile(file, { duration: true, skipCovers: false });
        const common = metadata.common;
        const title = common.title?.trim() || path.basename(file, path.extname(file));
        const artist = common.artist?.trim() || "Unknown Artist";
        const album = common.album?.trim() || "Unknown Album";
        const albumArtist = common.albumartist?.trim() || (common.compilation ? "Various Artists" : artist);
        const albumId = createHash("sha1").update(`${albumArtist.toLocaleLowerCase()}\0${album.toLocaleLowerCase()}`).digest("hex");
        let artwork: { path: string; source: "embedded" | "folder" } | null = null;
        if (!artworkFound.has(albumId) && !this.getArtworkPath(albumId)) {
          artwork = await this.cacheArtwork(albumId, file, common.picture?.[0]);
          if (artwork) artworkFound.add(albumId);
        }
        upsertAlbum.run(albumId, album, albumArtist, common.year ?? null, artwork?.path ?? null, artwork?.source ?? null, artwork ? Date.now() : 0);
        upsertTrack.run(file, root, path.relative(root, file), albumId, title, artist, album, albumArtist, common.track.no ?? 0, common.disk.no ?? 0, metadata.format.duration ?? 0, common.year ?? null, JSON.stringify(normaliseGenres(common.genre)), fileStat.mtimeMs, scanToken);
      } catch (error) {
        const relativePath = path.relative(root, file);
        const existing = (existingFile.get(file) ?? existingRelative.get(relativePath)) as Row | undefined;
        const existingId = existing?.id ?? (this.db.prepare("SELECT id FROM tracks WHERE path = ?").get(file) as Row | undefined)?.id;
        if (existingId) markUnchanged.run(scanToken, root, file, relativePath, Number(existingId));
        console.warn(`Could not read metadata for ${file}`, error);
      }
    }
    onProgress({ phase: "finishing", current: files.length, total: files.length });
    const scannedCount = this.db.prepare("SELECT COUNT(*) AS count FROM tracks WHERE source_root = ? AND scan_token = ?").get(root, scanToken) as Row;
    if (files.length > 0 && Number(scannedCount.count) === 0 && Number(existingCount.count) > 0) {
      throw new Error("None of the visible audio files could be read. The existing catalogue was retained.");
    }
    this.db.prepare("DELETE FROM tracks WHERE source_root = ? AND scan_token != ?").run(root, scanToken);
    this.db.prepare("DELETE FROM tracks WHERE source_root != ?").run(root);
    this.db.prepare("DELETE FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks)").run();
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('library_root', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(root);
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('genre_metadata_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    this.genreMetadataReady = true;
  }

  async fetchAlbumArtwork(albumId: string): Promise<ArtworkResult> {
    const row = this.db.prepare("SELECT title, artist FROM albums WHERE id = ?").get(albumId) as Row | undefined;
    if (!row) return { success: false, message: "Album not found", albumId };
    const title = String(row.title);
    const artist = String(row.artist);
    try {
      const searchUrl = new URL("https://musicbrainz.org/ws/2/release-group/");
      searchUrl.searchParams.set("query", `releasegroup:\"${escapeLucene(title)}\" AND artist:\"${escapeLucene(artist)}\"`);
      searchUrl.searchParams.set("fmt", "json");
      searchUrl.searchParams.set("limit", "5");
      const searchResponse = await this.fetchMusicBrainz(searchUrl);
      if (!searchResponse.ok) throw new Error(`MusicBrainz returned ${searchResponse.status}`);
      const data = await searchResponse.json() as { "release-groups"?: Array<{ id: string; title: string; score?: number; "artist-credit"?: Array<{ name: string }> }> };
      const candidates = data["release-groups"] ?? [];
      const exact = candidates.find((candidate) => {
        const candidateArtist = candidate["artist-credit"]?.map((credit) => credit.name).join(" ") ?? "";
        return normalise(candidate.title) === normalise(title) && normalise(candidateArtist).includes(normalise(artist));
      });
      const match = exact ?? candidates.find((candidate) => Number(candidate.score ?? 0) >= 85);
      if (!match) return { success: false, message: `No confident artwork match for ${title}`, albumId };
      const coverResponse = await fetchWithTimeout(`https://coverartarchive.org/release-group/${match.id}/front-500`, { headers: { "User-Agent": MUSICBRAINZ_USER_AGENT, Accept: "image/*" }, redirect: "follow" });
      if (!coverResponse.ok) return { success: false, message: `No front cover is available for ${title}`, albumId };
      const contentType = coverResponse.headers.get("content-type") ?? "image/jpeg";
      const extension = contentType.includes("png") ? ".png" : contentType.includes("webp") ? ".webp" : ".jpg";
      const destination = path.join(this.artworkDirectory, `${albumId}-online${extension}`);
      const coverBytes = new Uint8Array(await coverResponse.arrayBuffer());
      if (coverBytes.byteLength > MAX_ARTWORK_BYTES) throw new Error("The downloaded cover was unexpectedly large");
      await writeFile(destination, coverBytes);
      this.db.prepare("UPDATE albums SET artwork_path = ?, artwork_source = 'musicbrainz', artwork_updated_at = ?, musicbrainz_id = ? WHERE id = ?").run(destination, Date.now(), match.id, albumId);
      return { success: true, message: `Artwork found for ${title}`, albumId };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "Artwork lookup failed", albumId };
    }
  }

  async fetchMissingArtwork(onProgress: (progress: ArtworkProgress) => void): Promise<{ found: number; missing: number }> {
    const rows = this.db.prepare("SELECT id, title FROM albums WHERE artwork_path IS NULL ORDER BY artist, title").all() as Row[];
    let found = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      onProgress({ current: index + 1, total: rows.length, album: String(row.title), status: "searching" });
      const result = await this.fetchAlbumArtwork(String(row.id));
      if (result.success) found += 1;
      onProgress({ current: index + 1, total: rows.length, album: String(row.title), status: result.success ? "found" : "missing" });
      if (index < rows.length - 1) await delay(1100);
    }
    return { found, missing: rows.length - found };
  }

  async fetchArtistArtwork(artist: string): Promise<ArtworkResult> {
    const cleanArtist = artist.trim();
    if (!cleanArtist || cleanArtist === "Unknown Artist" || cleanArtist === "Various Artists") {
      return { success: false, message: `No artist portrait lookup is available for ${cleanArtist || "this artist"}`, albumId: cleanArtist };
    }
    try {
      const searchUrl = new URL("https://musicbrainz.org/ws/2/artist/");
      searchUrl.searchParams.set("query", `artist:\"${escapeLucene(cleanArtist)}\"`);
      searchUrl.searchParams.set("fmt", "json");
      searchUrl.searchParams.set("limit", "5");
      const searchResponse = await this.fetchMusicBrainz(searchUrl);
      if (!searchResponse.ok) throw new Error(`MusicBrainz returned ${searchResponse.status}`);
      const searchData = await searchResponse.json() as { artists?: Array<{ id: string; name: string; score?: number }> };
      const candidates = searchData.artists ?? [];
      const match = candidates.find((candidate) => normalise(candidate.name) === normalise(cleanArtist)) ?? candidates.find((candidate) => Number(candidate.score ?? 0) >= 90);
      if (!match) return { success: false, message: `No confident artist match for ${cleanArtist}`, albumId: cleanArtist };

      const lookupUrl = new URL(`https://musicbrainz.org/ws/2/artist/${match.id}`);
      lookupUrl.searchParams.set("inc", "url-rels");
      lookupUrl.searchParams.set("fmt", "json");
      const lookupResponse = await this.fetchMusicBrainz(lookupUrl);
      if (!lookupResponse.ok) throw new Error(`MusicBrainz returned ${lookupResponse.status}`);
      const lookupData = await lookupResponse.json() as { relations?: Array<{ type?: string; url?: { resource?: string } }> };
      const relations = lookupData.relations ?? [];
      const wikipedia = relations.find((relation) => relation.type === "wikipedia" && relation.url?.resource)?.url?.resource;
      const wikidata = relations.find((relation) => relation.type === "wikidata" && relation.url?.resource)?.url?.resource;
      const imageUrl = wikipedia ? await this.wikipediaImageUrl(wikipedia) : wikidata ? await this.wikidataImageUrl(wikidata) : null;
      if (!imageUrl) return { success: false, message: `No reusable portrait was found for ${cleanArtist}`, albumId: cleanArtist };

      const imageResponse = await fetchWithTimeout(imageUrl, { headers: { "User-Agent": MUSICBRAINZ_USER_AGENT, Accept: "image/*" }, redirect: "follow" });
      if (!imageResponse.ok) throw new Error(`Wikimedia returned ${imageResponse.status}`);
      const contentType = imageResponse.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) throw new Error("Wikimedia did not return an image");
      const extension = contentType.includes("png") ? ".png" : contentType.includes("webp") ? ".webp" : ".jpg";
      const artistId = createHash("sha1").update(cleanArtist.toLocaleLowerCase()).digest("hex");
      const destination = path.join(this.artworkDirectory, `artist-${artistId}${extension}`);
      await mkdir(this.artworkDirectory, { recursive: true });
      const imageBytes = new Uint8Array(await imageResponse.arrayBuffer());
      if (imageBytes.byteLength > MAX_ARTWORK_BYTES) throw new Error("The downloaded artist photo was unexpectedly large");
      await writeFile(destination, imageBytes);
      this.db.prepare(`
        INSERT INTO artist_images (name, image_path, image_source, image_updated_at, musicbrainz_id) VALUES (?, ?, 'wikimedia', ?, ?)
        ON CONFLICT(name) DO UPDATE SET image_path = excluded.image_path, image_source = excluded.image_source,
          image_updated_at = excluded.image_updated_at, musicbrainz_id = excluded.musicbrainz_id
      `).run(cleanArtist, destination, Date.now(), match.id);
      return { success: true, message: `Artist photo found for ${cleanArtist}`, albumId: cleanArtist };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "Artist photo lookup failed", albumId: cleanArtist };
    }
  }

  async fetchMissingArtistArtwork(onProgress: (progress: ArtworkProgress) => void): Promise<{ found: number; missing: number }> {
    const artists = this.snapshot().artists.filter((artist) => !artist.imageUrl);
    let found = 0;
    for (let index = 0; index < artists.length; index += 1) {
      const artist = artists[index];
      onProgress({ current: index + 1, total: artists.length, album: artist.name, status: "searching" });
      const result = await this.fetchArtistArtwork(artist.name);
      if (result.success) found += 1;
      onProgress({ current: index + 1, total: artists.length, album: artist.name, status: result.success ? "found" : "missing" });
    }
    return { found, missing: artists.length - found };
  }

  private async fetchMusicBrainz(url: URL): Promise<Response> {
    const request = this.musicBrainzQueue.then(async () => {
      const wait = Math.max(0, 1100 - (Date.now() - this.lastMusicBrainzRequest));
      if (wait > 0) await delay(wait);
      this.lastMusicBrainzRequest = Date.now();
      return fetchWithTimeout(url, { headers: { "User-Agent": MUSICBRAINZ_USER_AGENT, Accept: "application/json" } });
    });
    this.musicBrainzQueue = request.then(() => undefined, () => undefined);
    return request;
  }

  private async wikipediaImageUrl(resource: string): Promise<string | null> {
    try {
      const page = new URL(resource);
      const marker = "/wiki/";
      const markerIndex = page.pathname.indexOf(marker);
      if (markerIndex < 0 || !page.hostname.endsWith(".wikipedia.org")) return null;
      const title = decodeURIComponent(page.pathname.slice(markerIndex + marker.length)).replaceAll("_", " ");
      const api = new URL("/w/api.php", page.origin);
      api.searchParams.set("action", "query");
      api.searchParams.set("prop", "pageimages");
      api.searchParams.set("piprop", "thumbnail");
      api.searchParams.set("pithumbsize", "600");
      api.searchParams.set("pilicense", "free");
      api.searchParams.set("titles", title);
      api.searchParams.set("format", "json");
      api.searchParams.set("origin", "*");
      const response = await fetchWithTimeout(api, { headers: { "User-Agent": MUSICBRAINZ_USER_AGENT, Accept: "application/json" } });
      if (!response.ok) return null;
      const data = await response.json() as { query?: { pages?: Record<string, { thumbnail?: { source?: string } }> } };
      return Object.values(data.query?.pages ?? {}).find((entry) => entry.thumbnail?.source)?.thumbnail?.source ?? null;
    } catch { return null; }
  }

  private async wikidataImageUrl(resource: string): Promise<string | null> {
    try {
      const entityId = new URL(resource).pathname.split("/").filter(Boolean).pop();
      if (!entityId?.match(/^Q\d+$/)) return null;
      const entityApi = new URL("https://www.wikidata.org/w/api.php");
      entityApi.searchParams.set("action", "wbgetentities");
      entityApi.searchParams.set("ids", entityId);
      entityApi.searchParams.set("props", "claims");
      entityApi.searchParams.set("format", "json");
      entityApi.searchParams.set("origin", "*");
      const entityResponse = await fetchWithTimeout(entityApi, { headers: { "User-Agent": MUSICBRAINZ_USER_AGENT, Accept: "application/json" } });
      if (!entityResponse.ok) return null;
      const entityData = await entityResponse.json() as { entities?: Record<string, { claims?: { P18?: Array<{ mainsnak?: { datavalue?: { value?: string } } }> } }> };
      const fileName = entityData.entities?.[entityId]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (!fileName) return null;
      const commonsApi = new URL("https://commons.wikimedia.org/w/api.php");
      commonsApi.searchParams.set("action", "query");
      commonsApi.searchParams.set("prop", "imageinfo");
      commonsApi.searchParams.set("iiprop", "url");
      commonsApi.searchParams.set("iiurlwidth", "600");
      commonsApi.searchParams.set("titles", `File:${fileName}`);
      commonsApi.searchParams.set("format", "json");
      commonsApi.searchParams.set("origin", "*");
      const commonsResponse = await fetchWithTimeout(commonsApi, { headers: { "User-Agent": MUSICBRAINZ_USER_AGENT, Accept: "application/json" } });
      if (!commonsResponse.ok) return null;
      const commonsData = await commonsResponse.json() as { query?: { pages?: Record<string, { imageinfo?: Array<{ thumburl?: string; url?: string }> }> } };
      const info = Object.values(commonsData.query?.pages ?? {}).find((entry) => entry.imageinfo?.[0])?.imageinfo?.[0];
      return info?.thumburl ?? info?.url ?? null;
    } catch { return null; }
  }

  private async findAudioFiles(root: string): Promise<string[]> {
    const results: string[] = [];
    const failures: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch { failures.push(directory); return; }
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(fullPath);
        else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLocaleLowerCase())) results.push(fullPath);
      }
    };
    await visit(root);
    if (failures.length > 0) throw new Error(`Could not read ${failures.length} folder${failures.length === 1 ? "" : "s"} on the share. The catalogue was left unchanged.`);
    return results;
  }

  private async cacheArtwork(albumId: string, audioFile: string, embedded?: { data: Uint8Array; format: string }): Promise<{ path: string; source: "embedded" | "folder" } | null> {
    const extensionFor = (format: string) => format.includes("png") ? ".png" : format.includes("webp") ? ".webp" : ".jpg";
    if (embedded) {
      const destination = path.join(this.artworkDirectory, `${albumId}${extensionFor(embedded.format)}`);
      await writeFile(destination, embedded.data);
      return { path: destination, source: "embedded" };
    }
    const directory = path.dirname(audioFile);
    let names: string[] = [];
    try { names = await readdir(directory); } catch { return null; }
    const lookup = new Map(names.map((name) => [name.toLocaleLowerCase(), name]));
    for (const candidate of COVER_NAMES) {
      const actualName = lookup.get(candidate);
      if (!actualName) continue;
      const extension = path.extname(actualName).toLocaleLowerCase();
      const destination = path.join(this.artworkDirectory, `${albumId}${extension}`);
      await copyFile(path.join(directory, actualName), destination);
      return { path: destination, source: "folder" };
    }
    return null;
  }
}
