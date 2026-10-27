import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { ArtworkProgress, ArtworkResult, ConnectionStatus, Library, NasSettings, Playlist, ScanProgress, Track } from "./types";

type NativeEnvelope<T> = { value: T };
type NativeRecordShelfPlugin = {
  getLibrary(): Promise<NativeEnvelope<Library>>;
  chooseFolder(): Promise<{ root: string | null }>;
  scanFolder(options: { root: string }): Promise<NativeEnvelope<Library>>;
  createPlaylist(options: { name: string }): Promise<NativeEnvelope<Playlist>>;
  deletePlaylist(options: { playlistId: string }): Promise<NativeEnvelope<Library>>;
  addToPlaylist(options: { playlistId: string; trackId: number }): Promise<NativeEnvelope<Library>>;
  removeFromPlaylist(options: { playlistId: string; trackId: number }): Promise<NativeEnvelope<Library>>;
  fetchAlbumArtwork(options: { albumId: string }): Promise<{ result: ArtworkResult; library: Library }>;
  fetchMissingArtwork(): Promise<{ result: { found: number; missing: number }; library: Library }>;
  fetchArtistArtwork(options: { artist: string }): Promise<{ result: ArtworkResult; library: Library }>;
  fetchMissingArtistArtwork(): Promise<{ result: { found: number; missing: number }; library: Library }>;
  getTrackUrl(options: { trackId: number }): Promise<{ url: string }>;
  addListener(eventName: "scanProgress", listener: (progress: ScanProgress) => void): Promise<PluginListenerHandle>;
};

const NativeRecordShelf = registerPlugin<NativeRecordShelfPlugin>("RecordShelf");
export const isNativeAndroid = Capacitor.getPlatform() === "android";

function normaliseLibrary(library: Library): Library {
  const artists = Array.isArray(library.artists) ? library.artists : [];
  const albums = library.albums.map((album) => ({
    ...album,
    tracks: album.tracks.map((track) => ({ ...track, genres: Array.isArray(track.genres) ? track.genres.filter((genre): genre is string => typeof genre === "string" && genre.trim().length > 0) : [] })),
  }));
  if (!isNativeAndroid) return { ...library, albums, artists };
  return {
    ...library,
    albums: albums.map((album) => ({
      ...album,
      artworkUrl: album.artworkUrl ? Capacitor.convertFileSrc(album.artworkUrl) : null,
    })),
    artists: artists.map((artist) => ({ ...artist, imageUrl: artist.imageUrl ? Capacitor.convertFileSrc(artist.imageUrl) : null })),
  };
}

function nativeListener(eventName: "scanProgress", callback: (progress: ScanProgress) => void): () => void {
  let disposed = false;
  const listener = NativeRecordShelf.addListener(eventName, callback);
  void listener.then((handle) => { if (disposed) void handle.remove(); });
  return () => { disposed = true; void listener.then((handle) => handle.remove()); };
}

const mobileBridge: Window["recordShelf"] = {
  getLibrary: async () => normaliseLibrary((await NativeRecordShelf.getLibrary()).value),
  chooseFolder: async () => (await NativeRecordShelf.chooseFolder()).root,
  scanFolder: async (root) => normaliseLibrary((await NativeRecordShelf.scanFolder({ root })).value),
  getNasSettings: async (): Promise<NasSettings> => ({ server: "", share: "", subfolder: "", username: "", autoConnect: true, hasPassword: false }),
  getConnectionStatus: async (): Promise<ConnectionStatus> => ({ state: "connected", message: "Android folder permission saved", root: null }),
  saveNasSettings: async () => { throw new Error("On Android, choose the NAS through the system Files screen. Direct SMB setup is not available in this build yet."); },
  connectNas: async () => ({ status: { state: "connected" as const, message: "Android will reconnect through its saved file provider", root: null }, library: normaliseLibrary((await NativeRecordShelf.getLibrary()).value) }),
  createPlaylist: async (name) => (await NativeRecordShelf.createPlaylist({ name })).value,
  deletePlaylist: async (playlistId) => normaliseLibrary((await NativeRecordShelf.deletePlaylist({ playlistId })).value),
  addToPlaylist: async (playlistId, trackId) => normaliseLibrary((await NativeRecordShelf.addToPlaylist({ playlistId, trackId })).value),
  removeFromPlaylist: async (playlistId, trackId) => normaliseLibrary((await NativeRecordShelf.removeFromPlaylist({ playlistId, trackId })).value),
  fetchAlbumArtwork: async (albumId) => {
    const response = await NativeRecordShelf.fetchAlbumArtwork({ albumId });
    return { ...response, library: normaliseLibrary(response.library) };
  },
  fetchMissingArtwork: async () => {
    const response = await NativeRecordShelf.fetchMissingArtwork();
    return { ...response, library: normaliseLibrary(response.library) };
  },
  fetchArtistArtwork: async (artist) => {
    const response = await NativeRecordShelf.fetchArtistArtwork({ artist });
    return { ...response, library: normaliseLibrary(response.library) };
  },
  fetchMissingArtistArtwork: async () => {
    const response = await NativeRecordShelf.fetchMissingArtistArtwork();
    return { ...response, library: normaliseLibrary(response.library) };
  },
  onScanProgress: (callback) => nativeListener("scanProgress", callback),
  onArtworkProgress: (_callback: (progress: ArtworkProgress) => void) => () => undefined,
  onChooseLibrary: () => () => undefined,
  onPlayerCommand: () => () => undefined,
  onConnectionStatus: () => () => undefined,
};

export const recordShelf: Window["recordShelf"] = window.recordShelf ?? mobileBridge;

export async function trackPlaybackUrl(track: Track): Promise<string> {
  if (!isNativeAndroid) return `music-file://track/${track.id}`;
  const { url } = await NativeRecordShelf.getTrackUrl({ trackId: track.id });
  return Capacitor.convertFileSrc(url);
}
