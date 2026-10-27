import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Album, Artist, ArtworkProgress, ConnectionStatus, Library, NasSettingsInput, ScanProgress, Track } from "./types";
import { isNativeAndroid, recordShelf, trackPlaybackUrl } from "./platform";

type View = "albums" | "artists" | "genres" | "songs" | "playlist" | "queue";
type AlbumLayout = "shelf" | "detail" | "covers" | "list";
type RepeatMode = "off" | "all" | "one";
type Notice = { kind: "success" | "error" | "info"; message: string };

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function shuffleTracks(tracks: Track[]): Track[] {
  const shuffled = [...tracks];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }
  return shuffled;
}

function Artwork({ album, className = "" }: { album?: Album; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [album?.artworkUrl]);
  return album?.artworkUrl && !failed
    ? <img className={`artwork ${className}`} src={album.artworkUrl} alt={`${album.title} cover`} onError={() => setFailed(true)} />
    : <div className={`artwork placeholder ${className}`}><span>♪</span><small>{album?.title ?? "Record Shelf"}</small></div>;
}

function ArtistArtwork({ artist, fallbackAlbum }: { artist: Artist; fallbackAlbum?: Album }) {
  const [failed, setFailed] = useState(false);
  const imageUrl = artist.imageUrl ?? fallbackAlbum?.artworkUrl ?? null;
  useEffect(() => setFailed(false), [imageUrl]);
  return imageUrl && !failed
    ? <img className="artist-avatar" src={imageUrl} alt={artist.imageUrl ? `${artist.name} portrait` : `${artist.name} representative album cover`} onError={() => setFailed(true)} />
    : <div className="artist-avatar"><span>{artist.name.slice(0, 2).toUpperCase()}</span></div>;
}

function LayoutSwitcher({ value, onChange }: { value: AlbumLayout; onChange: (layout: AlbumLayout) => void }) {
  const options: Array<{ id: AlbumLayout; icon: string; label: string }> = [
    { id: "shelf", icon: "▱", label: "Shelf" }, { id: "detail", icon: "◫", label: "Album" },
    { id: "covers", icon: "▦", label: "Covers" }, { id: "list", icon: "☷", label: "List" },
  ];
  return <div className="layout-switcher" role="group" aria-label="Album view">
    {options.map((option) => <button key={option.id} className={value === option.id ? "active" : ""} onClick={() => onChange(option.id)} title={`${option.label} view`}><span>{option.icon}</span>{option.label}</button>)}
  </div>;
}

export default function App() {
  const [library, setLibrary] = useState<Library>({ root: null, albums: [], artists: [], playlists: [] });
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [expandedAlbumId, setExpandedAlbumId] = useState<string | null>(null);
  const [view, setView] = useState<View>("albums");
  const [albumLayout, setAlbumLayoutState] = useState<AlbumLayout>(() => (localStorage.getItem("album-layout") as AlbumLayout) || "shelf");
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [selectedArtist, setSelectedArtist] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [artworkProgress, setArtworkProgress] = useState<ArtworkProgress | null>(null);
  const [artworkBusy, setArtworkBusy] = useState<string | null>(null);
  const [artistArtworkBusy, setArtistArtworkBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>(() => {
    const saved = localStorage.getItem("repeat-mode");
    return saved === "all" || saved === "one" ? saved : "off";
  });
  const [elapsed, setElapsed] = useState(0);
  const [volume, setVolume] = useState(0.82);
  const [playlistDialog, setPlaylistDialog] = useState<{ track: Track | null } | null>(null);
  const [playlistToDelete, setPlaylistToDelete] = useState<{ id: string; name: string } | null>(null);
  const [nasDialog, setNasDialog] = useState(false);
  const [nasSaving, setNasSaving] = useState(false);
  const [nasForm, setNasForm] = useState<NasSettingsInput>({ server: "", share: "", subfolder: "", username: "", password: "", autoConnect: true });
  const [nasHasPassword, setNasHasPassword] = useState(false);
  const [nasFeedback, setNasFeedback] = useState<{ kind: "testing" | "success" | "error"; title: string; message: string } | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({ state: "local", message: "Using a local or mounted folder", root: null });
  const [trackMenu, setTrackMenu] = useState<{ track: Track; x: number; y: number } | null>(null);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const audioRef = useRef(new Audio());
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const shelfRef = useRef<HTMLDivElement>(null);
  const trackScrollRef = useRef<HTMLDivElement>(null);
  const playbackRequestRef = useRef(0);
  const loadedTrackIdRef = useRef<number | null>(null);
  const shouldPlayRef = useRef(false);
  const repeatModeRef = useRef<RepeatMode>(repeatMode);
  const screenPositionsRef = useRef<Record<string, number>>({});
  const shelfPositionsRef = useRef<Record<string, number>>({});

  const allTracks = useMemo(() => library.albums.flatMap((album) => album.tracks), [library.albums]);
  const currentAlbum = useMemo(() => library.albums.find((album) => album.id === currentTrack?.albumId), [library.albums, currentTrack]);
  const filteredAlbums = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return library.albums.filter((album) => (!selectedArtist || album.artist === selectedArtist) && (!needle || `${album.title} ${album.artist} ${album.year ?? ""} ${album.tracks.map((track) => `${track.title} ${(track.genres ?? []).join(" ")}`).join(" ")}`.toLocaleLowerCase().includes(needle)));
  }, [library.albums, query, selectedArtist]);
  const selectedAlbum = useMemo(() => filteredAlbums.find((album) => album.id === selectedAlbumId) ?? filteredAlbums[0], [filteredAlbums, selectedAlbumId]);
  const artists = useMemo(() => Array.from(new Set(library.albums.map((album) => album.artist))).sort((left, right) => left.localeCompare(right)).map((name) => library.artists.find((artist) => artist.name.toLocaleLowerCase() === name.toLocaleLowerCase()) ?? { name, imageUrl: null, imageSource: null }), [library.albums, library.artists]);
  const genreGroups = useMemo(() => {
    const groups = new Map<string, { name: string; tracks: Track[]; trackIds: Set<number> }>();
    for (const track of allTracks) {
      const names = track.genres?.length ? track.genres : ["Unknown Genre"];
      for (const rawName of names) {
        const name = rawName.trim();
        if (!name) continue;
        const key = name.toLocaleLowerCase();
        const group = groups.get(key) ?? { name, tracks: [], trackIds: new Set<number>() };
        if (!group.trackIds.has(track.id)) { group.trackIds.add(track.id); group.tracks.push(track); }
        groups.set(key, group);
      }
    }
    return Array.from(groups.values()).sort((left, right) => left.name.localeCompare(right.name));
  }, [allTracks]);
  const filteredGenreGroups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return genreGroups.filter((group) => !needle || `${group.name} ${group.tracks.map((track) => `${track.title} ${track.artist} ${track.album}`).join(" ")}`.toLocaleLowerCase().includes(needle));
  }, [genreGroups, query]);
  const selectedArtistTracks = useMemo(() => selectedArtist ? library.albums.filter((album) => album.artist === selectedArtist).flatMap((album) => album.tracks) : [], [library.albums, selectedArtist]);
  const activePlaylist = library.playlists.find((playlist) => playlist.id === selectedPlaylistId);
  const playlistTracks = activePlaylist ? activePlaylist.trackIds.map((id) => allTracks.find((track) => track.id === id)).filter(Boolean) as Track[] : [];
  const screenKey = view === "albums" ? `albums:${albumLayout}:${selectedArtist ?? "all"}` : view === "playlist" ? `playlist:${selectedPlaylistId ?? "none"}` : view;

  const setAlbumLayout = (layout: AlbumLayout) => {
    setAlbumLayoutState(layout);
    localStorage.setItem("album-layout", layout);
  };

  const playTrack = useCallback((track: Track, newQueue: Track[] | null = [track]) => {
    const audio = audioRef.current;
    const requestId = ++playbackRequestRef.current;
    shouldPlayRef.current = true;
    loadedTrackIdRef.current = null;
    audio.pause();
    if (newQueue !== null) setQueue(newQueue);
    setCurrentTrack(track);
    setElapsed(0);
    void trackPlaybackUrl(track).then((url) => {
      if (requestId !== playbackRequestRef.current) return;
      audio.src = url;
      loadedTrackIdRef.current = track.id;
      if (shouldPlayRef.current) return audio.play();
    }).catch(() => {
      shouldPlayRef.current = false;
      setNotice({ kind: "error", message: "This track could not be played. Check that the music location is available and the format is supported." });
    });
  }, []);

  const shuffleAndPlay = useCallback((tracks: Track[], label: string) => {
    if (tracks.length === 0) {
      setNotice({ kind: "info", message: `${label} has no songs to shuffle` });
      return;
    }
    const shuffled = shuffleTracks(tracks);
    setShuffleEnabled(true);
    playTrack(shuffled[0], shuffled);
    setNotice({ kind: "success", message: `Shuffling ${label} · ${shuffled.length} ${shuffled.length === 1 ? "song" : "songs"}` });
  }, [playTrack]);

  const toggleShuffle = useCallback(() => {
    const enabled = !shuffleEnabled;
    setShuffleEnabled(enabled);
    if (!enabled) {
      setNotice({ kind: "info", message: "Shuffle off · the current Up Next order is unchanged" });
      return;
    }
    setQueue((current) => {
      if (current.length > 1) {
        const currentIndex = currentTrack ? current.findIndex((track) => track.id === currentTrack.id) : -1;
        if (currentIndex >= 0) return [...current.slice(0, currentIndex + 1), ...shuffleTracks(current.slice(currentIndex + 1))];
        return shuffleTracks(current);
      }
      if (allTracks.length <= 1) return current;
      const candidates = currentTrack ? allTracks.filter((track) => track.id !== currentTrack.id) : allTracks;
      return currentTrack ? [currentTrack, ...shuffleTracks(candidates)] : shuffleTracks(candidates);
    });
    setNotice({ kind: "success", message: queue.length > 1 ? "Shuffle on · upcoming songs randomized" : "Shuffle on · library added to Up Next" });
  }, [allTracks, currentTrack, queue.length, shuffleEnabled]);

  const cycleRepeatMode = useCallback(() => {
    const next: RepeatMode = repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off";
    repeatModeRef.current = next;
    setRepeatMode(next);
    localStorage.setItem("repeat-mode", next);
    setNotice({ kind: "info", message: next === "all" ? "Repeat all on" : next === "one" ? "Repeat one on" : "Repeat off" });
  }, [repeatMode]);

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!currentTrack) {
      const first = queue[0] ?? selectedAlbum?.tracks[0] ?? allTracks[0];
      if (first) playTrack(first, queue.length ? null : [first]);
      return;
    }
    if (audio.paused) {
      shouldPlayRef.current = true;
      if (loadedTrackIdRef.current === currentTrack.id) void audio.play().catch(() => setNotice({ kind: "error", message: "Playback failed because the file is currently unavailable." }));
    } else {
      shouldPlayRef.current = false;
      audio.pause();
    }
  }, [allTracks, currentTrack, playTrack, queue, selectedAlbum]);

  const nextTrack = useCallback(() => {
    if (!currentTrack || queue.length === 0) return;
    const index = queue.findIndex((track) => track.id === currentTrack.id);
    const next = queue[index < 0 ? 0 : index + 1];
    if (next) playTrack(next, null);
    else if (repeatModeRef.current === "all" && queue[0]) playTrack(queue[0], null);
    else shouldPlayRef.current = false;
  }, [currentTrack, playTrack, queue]);

  const handleTrackEnded = useCallback(() => {
    if (repeatModeRef.current === "one" && currentTrack) {
      const audio = audioRef.current;
      audio.currentTime = 0;
      shouldPlayRef.current = true;
      void audio.play().catch(() => {
        shouldPlayRef.current = false;
        setNotice({ kind: "error", message: "This track could not be repeated because the file is unavailable." });
      });
      return;
    }
    nextTrack();
  }, [currentTrack, nextTrack]);

  const previousTrack = useCallback(() => {
    const audio = audioRef.current;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (!currentTrack || queue.length === 0) return;
    const index = queue.findIndex((track) => track.id === currentTrack.id);
    const previous = queue[index > 0 ? index - 1 : -1];
    if (previous) playTrack(previous, null);
    else if (repeatModeRef.current === "all" && queue.length > 0) playTrack(queue[queue.length - 1], null);
  }, [currentTrack, playTrack, queue]);

  const runScan = useCallback(async (root: string) => {
    setNotice(null);
    setScanProgress({ phase: "discovering", current: 0, total: 0 });
    try {
      const snapshot = await recordShelf.scanFolder(root);
      setLibrary(snapshot);
      setSelectedAlbumId((current) => snapshot.albums.some((album) => album.id === current) ? current : snapshot.albums[0]?.id ?? null);
      setNotice({ kind: "success", message: `Library ready · ${snapshot.albums.length} albums · ${snapshot.albums.flatMap((album) => album.tracks).length} songs` });
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "The library scan failed." });
    } finally { setScanProgress(null); }
  }, []);

  const chooseAndScan = useCallback(async () => {
    const root = await recordShelf.chooseFolder();
    if (root) await runScan(root);
  }, [runScan]);
  const rescan = useCallback(async () => library.root ? runScan(library.root) : chooseAndScan(), [chooseAndScan, library.root, runScan]);

  const openNasSettings = useCallback(async () => {
    if (isNativeAndroid) { void chooseAndScan(); return; }
    try {
      const settings = await recordShelf.getNasSettings();
      setNasForm({ server: settings.server, share: settings.share, subfolder: settings.subfolder, username: settings.username, password: "", autoConnect: settings.autoConnect });
      setNasHasPassword(settings.hasPassword);
      setNasFeedback(null);
      setNasDialog(true);
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "NAS settings could not be opened." });
    }
  }, [chooseAndScan]);

  const saveNasSettings = useCallback(async () => {
    setNasSaving(true);
    setNasFeedback({ kind: "testing", title: "Testing connection…", message: `Contacting ${nasForm.server.trim()} and opening the ${nasForm.share.trim()} share.` });
    try {
      const response = await recordShelf.saveNasSettings(nasForm);
      setConnectionStatus(response.status);
      setLibrary(response.library);
      setNasHasPassword(response.settings.hasPassword);
      if (response.status.state !== "connected") throw new Error(response.status.message);
      const connectedLocation = response.status.root ?? `${response.settings.server}/${response.settings.share}`;
      setNasFeedback({ kind: "success", title: "Connection successful", message: `Music is available at ${connectedLocation}. Automatic reconnection is ${response.settings.autoConnect ? "on" : "off"}.` });
      if (response.status.root && response.library.albums.length === 0) await runScan(response.status.root);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The NAS could not be connected.";
      const guidance = /timed out/i.test(message)
        ? " Check that the NAS is awake and on the same network, then confirm the address and share name."
        : /password|credential|authentication|permission|denied/i.test(message)
          ? " Check the username and password, and make sure that account can open this share."
          : /not found|does not exist|no such/i.test(message)
            ? " Check the share name and optional music subfolder."
            : " Check the NAS address, share name, and network connection, then try again.";
      setNasFeedback({ kind: "error", title: "Connection failed", message: `${message}${guidance}` });
    } finally { setNasSaving(false); }
  }, [nasForm, runScan]);

  const retryConnection = useCallback(async () => {
    setConnectionStatus((current) => ({ ...current, state: "connecting", message: "Connecting to music library…" }));
    try {
      const response = await recordShelf.connectNas();
      setConnectionStatus(response.status);
      setLibrary(response.library);
      if (response.status.state !== "connected" && response.status.state !== "local") setNotice({ kind: "error", message: response.status.message });
    } catch (error) { setNotice({ kind: "error", message: error instanceof Error ? error.message : "The NAS is unavailable." }); }
  }, []);

  const useLocalFolder = useCallback(async () => {
    setNasSaving(true);
    try {
      const response = await recordShelf.saveNasSettings({ server: "", share: "", subfolder: "", username: "", password: "", autoConnect: false });
      setConnectionStatus(response.status);
      setNasDialog(false);
      await chooseAndScan();
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "The local music folder could not be selected." });
    } finally { setNasSaving(false); }
  }, [chooseAndScan]);

  useEffect(() => {
    void recordShelf.getLibrary()
      .then((snapshot) => { setLibrary(snapshot); setSelectedAlbumId(snapshot.albums[0]?.id ?? null); })
      .catch(() => setNotice({ kind: "error", message: "The saved music catalogue could not be opened." }));
    void recordShelf.getConnectionStatus().then(setConnectionStatus).catch(() => undefined);
    const removeProgress = recordShelf.onScanProgress(setScanProgress);
    const removeArtworkProgress = recordShelf.onArtworkProgress(setArtworkProgress);
    const removeChoose = recordShelf.onChooseLibrary(() => void chooseAndScan());
    const removeConnection = recordShelf.onConnectionStatus(setConnectionStatus);
    return () => { removeProgress(); removeArtworkProgress(); removeChoose(); removeConnection(); };
  }, [chooseAndScan]);

  useEffect(() => {
    const audio = audioRef.current;
    const playing = () => setIsPlaying(true);
    const paused = () => setIsPlaying(false);
    const time = () => setElapsed(audio.currentTime);
    const failed = () => { shouldPlayRef.current = false; setNotice({ kind: "error", message: "Playback stopped because the audio file could not be read." }); };
    audio.addEventListener("play", playing); audio.addEventListener("pause", paused); audio.addEventListener("timeupdate", time);
    audio.addEventListener("ended", handleTrackEnded); audio.addEventListener("error", failed);
    return () => {
      audio.removeEventListener("play", playing); audio.removeEventListener("pause", paused); audio.removeEventListener("timeupdate", time);
      audio.removeEventListener("ended", handleTrackEnded); audio.removeEventListener("error", failed);
    };
  }, [handleTrackEnded]);
  useEffect(() => { audioRef.current.volume = volume; }, [volume]);
  useEffect(() => recordShelf.onPlayerCommand((command) => {
    if (command === "toggle") togglePlayback();
    if (command === "next") nextTrack();
    if (command === "previous") previousTrack();
    if (command === "stop") { shouldPlayRef.current = false; audioRef.current.pause(); audioRef.current.currentTime = 0; setElapsed(0); }
  }), [nextTrack, previousTrack, togglePlayback]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "l") { event.preventDefault(); searchRef.current?.focus(); }
      if (event.code === "Space" && !editing) { event.preventDefault(); togglePlayback(); }
      if (event.key === "Escape") { setPlaylistDialog(null); setPlaylistToDelete(null); setNasDialog(false); setTrackMenu(null); setNotice(null); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [togglePlayback]);

  useEffect(() => {
    if (!trackMenu) return;
    const close = () => setTrackMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("blur", close); };
  }, [trackMenu]);

  useLayoutEffect(() => {
    const main = mainRef.current;
    if (main) main.scrollTop = screenPositionsRef.current[screenKey] ?? 0;
    if (view === "albums" && albumLayout === "shelf" && shelfRef.current) shelfRef.current.scrollLeft = shelfPositionsRef.current[screenKey] ?? 0;
  }, [albumLayout, screenKey, view]);

  useLayoutEffect(() => {
    if (albumLayout === "shelf" && trackScrollRef.current) trackScrollRef.current.scrollTop = 0;
  }, [albumLayout, selectedAlbumId]);

  useEffect(() => {
    if (!currentTrack || !("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: currentTrack.title, artist: currentTrack.artist, album: currentTrack.album, artwork: currentAlbum?.artworkUrl ? [{ src: currentAlbum.artworkUrl }] : [] });
    navigator.mediaSession.setActionHandler("play", () => void audioRef.current.play());
    navigator.mediaSession.setActionHandler("pause", () => audioRef.current.pause());
    navigator.mediaSession.setActionHandler("nexttrack", nextTrack);
    navigator.mediaSession.setActionHandler("previoustrack", previousTrack);
  }, [currentAlbum, currentTrack, nextTrack, previousTrack]);

  const showAlbum = (album: Album) => { setSelectedAlbumId(album.id); setView("albums"); setSelectedPlaylistId(null); };
  const showNowPlayingAlbum = () => {
    if (!currentAlbum) return;
    screenPositionsRef.current["albums:detail:all"] = 0;
    setQuery("");
    setSelectedArtist(null);
    setSelectedPlaylistId(null);
    setExpandedAlbumId(null);
    setSelectedAlbumId(currentAlbum.id);
    setAlbumLayout("detail");
    setView("albums");
  };
  const showArtist = (artist: string) => {
    const firstAlbum = library.albums.find((album) => album.artist === artist);
    setSelectedArtist(artist);
    setSelectedAlbumId(firstAlbum?.id ?? null);
    setSelectedPlaylistId(null);
    setView("albums");
  };
  const selectRelativeAlbum = (offset: number) => {
    if (!selectedAlbum || filteredAlbums.length === 0) return;
    const index = filteredAlbums.findIndex((album) => album.id === selectedAlbum.id);
    setSelectedAlbumId(filteredAlbums[(Math.max(index, 0) + offset + filteredAlbums.length) % filteredAlbums.length].id);
  };
  const scrollShelf = (direction: number) => {
    const shelf = shelfRef.current;
    if (!shelf) return;
    const distance = Math.max(420, shelf.clientWidth * .7);
    shelf.scrollLeft = Math.max(0, Math.min(shelf.scrollWidth - shelf.clientWidth, shelf.scrollLeft + direction * distance));
  };

  const fetchArtwork = async (album: Album) => {
    setArtworkBusy(album.id); setNotice({ kind: "info", message: `Searching MusicBrainz for “${album.title}”…` });
    try {
      const response = await recordShelf.fetchAlbumArtwork(album.id);
      setLibrary(response.library);
      setNotice({ kind: response.result.success ? "success" : "error", message: response.result.message });
    } catch { setNotice({ kind: "error", message: "The artwork service could not be reached. Try again later." }); }
    finally { setArtworkBusy(null); }
  };
  const fetchAllMissingArtwork = async () => {
    setArtworkBusy("all"); setArtworkProgress(null); setNotice({ kind: "info", message: "Searching MusicBrainz and the Cover Art Archive for missing covers…" });
    try {
      const response = await recordShelf.fetchMissingArtwork();
      setLibrary(response.library);
      setNotice({ kind: "success", message: `Artwork search complete · ${response.result.found} found · ${response.result.missing} unmatched` });
    } catch { setNotice({ kind: "error", message: "The artwork service could not be reached. Try again later." }); }
    finally { setArtworkBusy(null); setArtworkProgress(null); }
  };

  const fetchAllMissingArtistArtwork = async () => {
    setArtistArtworkBusy(true); setArtworkProgress(null); setNotice({ kind: "info", message: "Finding artist portraits through MusicBrainz and Wikimedia…" });
    try {
      const response = await recordShelf.fetchMissingArtistArtwork();
      setLibrary(response.library);
      setNotice({ kind: "success", message: `Artist photo search complete · ${response.result.found} found · ${response.result.missing} unmatched` });
    } catch { setNotice({ kind: "error", message: "Artist photos could not be retrieved. Try again later." }); }
    finally { setArtistArtworkBusy(false); setArtworkProgress(null); }
  };

  const openPlaylistDialog = (track: Track | null = null) => { setNewPlaylistName(""); setPlaylistDialog({ track }); };
  const createPlaylist = async () => {
    if (!newPlaylistName.trim()) return;
    try {
      const playlist = await recordShelf.createPlaylist(newPlaylistName);
      if (playlistDialog?.track) setLibrary(await recordShelf.addToPlaylist(playlist.id, playlistDialog.track.id));
      else setLibrary((current) => ({ ...current, playlists: [...current.playlists, playlist] }));
      setPlaylistDialog(null);
    } catch { setNotice({ kind: "error", message: "The playlist could not be created." }); }
  };
  const choosePlaylist = async (playlistId: string) => {
    if (!playlistDialog?.track) return;
    setLibrary(await recordShelf.addToPlaylist(playlistId, playlistDialog.track.id)); setPlaylistDialog(null);
  };
  const removeFromPlaylist = async (trackId: number) => {
    if (activePlaylist) setLibrary(await recordShelf.removeFromPlaylist(activePlaylist.id, trackId));
  };
  const deletePlaylist = async () => {
    if (!playlistToDelete) return;
    try {
      const snapshot = await recordShelf.deletePlaylist(playlistToDelete.id);
      setLibrary(snapshot);
      setSelectedPlaylistId(null);
      setView("albums");
      setNotice({ kind: "success", message: `Playlist “${playlistToDelete.name}” deleted` });
    } catch {
      setNotice({ kind: "error", message: "The playlist could not be deleted." });
    } finally {
      setPlaylistToDelete(null);
    }
  };

  const playNext = (track: Track) => {
    setQueue((current) => {
      if (!currentTrack) return [track, ...current];
      const currentIndex = current.findIndex((item) => item.id === currentTrack.id);
      if (currentIndex < 0) return [currentTrack, track, ...current];
      const next = [...current];
      next.splice(currentIndex + 1, 0, track);
      return next;
    });
    setNotice({ kind: "success", message: `“${track.title}” will play next` });
  };

  const addToQueue = (track: Track) => {
    setQueue((current) => currentTrack && !current.some((item) => item.id === currentTrack.id) ? [currentTrack, ...current, track] : [...current, track]);
    setNotice({ kind: "success", message: `“${track.title}” added to Up Next` });
  };

  const addAlbumToQueue = (album: Album) => {
    setQueue((current) => {
      const runningOrder = currentTrack && !current.some((track) => track.id === currentTrack.id) ? [currentTrack, ...current] : current;
      const tracksToAdd = currentTrack ? album.tracks.filter((track) => track.id !== currentTrack.id) : album.tracks;
      return [...runningOrder, ...tracksToAdd];
    });
    setNotice({ kind: "success", message: `${album.tracks.length} tracks from “${album.title}” added to Up Next` });
  };

  const openTrackMenu = (track: Track, button: HTMLButtonElement) => {
    const bounds = button.getBoundingClientRect();
    const menuWidth = 216;
    const menuHeight = 174;
    const x = Math.max(8, Math.min(bounds.right - menuWidth, window.innerWidth - menuWidth - 8));
    const y = bounds.bottom + menuHeight + 8 <= window.innerHeight ? bounds.bottom + 4 : Math.max(8, bounds.top - menuHeight - 4);
    setTrackMenu({ track, x, y });
  };

  const trackRows = (tracks: Track[], playlistMode = false, preserveQueue = false) => <div className="track-list">
    {tracks.map((track, index) => <div key={`${track.id}-${index}`} className={currentTrack?.id === track.id ? "track active" : "track"} onDoubleClick={() => playTrack(track, preserveQueue ? null : [track])}>
      <button className="track-play" onClick={() => playTrack(track, preserveQueue ? null : [track])} aria-label={`Play ${track.title}`}>{currentTrack?.id === track.id && isPlaying ? "❚❚" : track.trackNumber || index + 1}</button>
      <div className="track-name"><b>{track.title}</b><span>{track.artist}</span></div>
      <span className="track-album">{track.album}</span>
      <button className="track-actions" title={`Actions for ${track.title}`} aria-label={`Actions for ${track.title}`} aria-haspopup="menu" onClick={(event) => { event.stopPropagation(); openTrackMenu(track, event.currentTarget); }}>•••</button>
      <time>{formatTime(track.duration)}</time>
      {playlistMode && <button className="remove-track" title="Remove from playlist" aria-label={`Remove ${track.title} from playlist`} onClick={() => void removeFromPlaylist(track.id)}>−</button>}
    </div>)}
  </div>;

  const albumActions = selectedAlbum && <div className="album-actions">
    <button className="primary" onClick={() => selectedAlbum.tracks[0] && playTrack(selectedAlbum.tracks[0], [selectedAlbum.tracks[0]])}>▶ Play</button>
    <button onClick={() => addAlbumToQueue(selectedAlbum)}>＋ Queue</button>
    <button onClick={() => void fetchArtwork(selectedAlbum)} disabled={artworkBusy !== null}>{artworkBusy === selectedAlbum.id ? "Searching…" : selectedAlbum.artworkUrl ? "↻ Find another cover" : "◇ Find cover online"}</button>
  </div>;

  const albumView = selectedAlbum && <>
    {albumLayout === "shelf" && <>
      <div className="shelf-shell">
        <button className="shelf-arrow left" onClick={() => scrollShelf(-1)} aria-label="Scroll albums left">‹</button>
        <div className="album-shelf horizontal" ref={shelfRef} onScroll={(event) => { shelfPositionsRef.current[screenKey] = event.currentTarget.scrollLeft; }} onWheel={(event) => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && shelfRef.current) { shelfRef.current.scrollLeft += event.deltaY; event.preventDefault(); } }}>
          {filteredAlbums.map((album) => <button key={album.id} className={`album-card ${selectedAlbum.id === album.id ? "selected" : ""}`} onClick={() => showAlbum(album)} onDoubleClick={() => album.tracks[0] && playTrack(album.tracks[0], [album.tracks[0]])}><Artwork album={album} /><b>{album.title}</b><span>{album.artist}</span></button>)}
        </div>
        <button className="shelf-arrow right" onClick={() => scrollShelf(1)} aria-label="Scroll albums right">›</button>
      </div>
      <section className="shelf-tracks">
        <div className="selected-album-bar"><Artwork album={selectedAlbum} /><div><p className="eyebrow">NOW SELECTED</p><h2>{selectedAlbum.title}</h2><span>{selectedAlbum.artist} · {selectedAlbum.year ?? "Year unknown"} · {selectedAlbum.tracks.length} songs</span></div>{albumActions}</div>
        <div className="track-scroll-region" ref={trackScrollRef}>{trackRows(selectedAlbum.tracks)}</div>
      </section>
    </>}
    {albumLayout === "detail" && <div className="album-detail classic-detail">
      <div className="detail-cover"><Artwork album={selectedAlbum} className="hero-art" /><div className="album-stepper"><button onClick={() => selectRelativeAlbum(-1)}>‹ Previous</button><button onClick={() => selectRelativeAlbum(1)}>Next ›</button></div></div>
      <div className="album-info"><p className="eyebrow">ALBUM</p><h2>{selectedAlbum.title}</h2><h3>{selectedAlbum.artist}</h3><p>{selectedAlbum.year ?? "Year unknown"} · {selectedAlbum.tracks.length} songs · {formatTime(selectedAlbum.tracks.reduce((sum, track) => sum + track.duration, 0))}</p>{albumActions}</div>
      {trackRows(selectedAlbum.tracks)}
    </div>}
    {albumLayout === "covers" && <div className="cover-grid">{filteredAlbums.map((album) => <button key={album.id} className={`cover-card ${selectedAlbum.id === album.id ? "selected" : ""}`} onClick={() => showAlbum(album)} onDoubleClick={() => album.tracks[0] && playTrack(album.tracks[0], [album.tracks[0]])}><Artwork album={album} /><b>{album.title}</b><span>{album.artist}</span><small>{album.year ?? ""}</small></button>)}</div>}
    {albumLayout === "list" && <div className="album-list">{filteredAlbums.map((album) => <div key={album.id} className={`album-list-item ${expandedAlbumId === album.id ? "selected" : ""}`}><button className="album-list-summary" aria-expanded={expandedAlbumId === album.id} onClick={() => { setSelectedAlbumId(album.id); setExpandedAlbumId((current) => current === album.id ? null : album.id); }}><Artwork album={album} /><div><b>{album.title}</b><span>{album.artist}</span></div><span>{album.year ?? "—"}</span><span>{album.tracks.length} songs</span><time>{formatTime(album.tracks.reduce((sum, track) => sum + track.duration, 0))}</time><i>{expandedAlbumId === album.id ? "⌃" : "⌄"}</i></button>{expandedAlbumId === album.id && <div className="album-list-expanded">{trackRows(album.tracks)}</div>}</div>)}</div>}
  </>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="traffic-space" />
      <div className="brand"><span className="brand-mark">RS</span><div className="brand-copy"><span className="brand-title-row"><b>Record Shelf</b><span className="app-version brand-version" aria-label={`Record Shelf version ${__APP_VERSION__}`}>v{__APP_VERSION__}</span></span><small>Your collection</small></div></div>
      <nav><p>LIBRARY</p>
        <button className={view === "albums" ? "active" : ""} onClick={() => { setSelectedArtist(null); setView("albums"); }}><span>▦</span> Albums</button>
        <button className={view === "artists" ? "active" : ""} onClick={() => setView("artists")}><span>♬</span> Artists</button>
        <button className={view === "genres" ? "active" : ""} onClick={() => setView("genres")}><span>◆</span> Genres</button>
        <button className={view === "songs" ? "active" : ""} onClick={() => setView("songs")}><span>≡</span> Songs</button>
        <p className="playlist-heading">PLAYLISTS <button className="add" onClick={() => openPlaylistDialog()} title="New playlist">＋</button></p>
        <button className={view === "queue" ? "active" : ""} onClick={() => { setSelectedPlaylistId(null); setView("queue"); }}><span>☷</span>Up Next<small className="queue-count">{queue.length}</small></button>
        {library.playlists.map((playlist) => <button key={playlist.id} className={selectedPlaylistId === playlist.id ? "active" : ""} onClick={() => { setSelectedPlaylistId(playlist.id); setView("playlist"); }}><span>♫</span>{playlist.name}</button>)}
      </nav>
      <button className="source-status" onClick={() => connectionStatus.state === "offline" ? void retryConnection() : void openNasSettings()} title={connectionStatus.state === "offline" ? "Retry NAS connection" : "Music source settings"}><span className={(connectionStatus.state === "connected" || (connectionStatus.state === "local" && !!library.root)) ? "status-dot online" : connectionStatus.state === "connecting" ? "status-dot connecting" : "status-dot"} /><div><b>{connectionStatus.state === "connecting" ? "Connecting…" : connectionStatus.state === "offline" ? "Library offline" : library.root ? "Library connected" : "No library"}</b><small>{connectionStatus.state === "offline" ? "Click to retry" : library.root ? (isNativeAndroid ? "Android music folder" : library.root.split(/[\\/]/).pop()) : isNativeAndroid ? "Choose a music location" : "Set up NAS or choose folder"}</small></div></button>
    </aside>

    <main ref={mainRef} className={view === "albums" && albumLayout === "shelf" ? "shelf-mode" : ""} onScroll={(event) => { screenPositionsRef.current[screenKey] = event.currentTarget.scrollTop; }}>
      <header className="topbar"><label className="search"><span>⌕</span><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search albums, artists and songs" /><kbd>⌘ L</kbd></label><div className="top-actions"><span className="app-version mobile-version" aria-label={`Record Shelf version ${__APP_VERSION__}`}>v{__APP_VERSION__}</span><button className="settings-button" onClick={() => void openNasSettings()} title="Music source settings">⚙</button><button className="art-button" onClick={() => void fetchAllMissingArtwork()} disabled={!library.albums.length || artworkBusy !== null}>◇ Find Artwork</button><button className="scan-button" onClick={() => void rescan()} disabled={!!scanProgress}>{scanProgress ? "Scanning…" : library.root ? "Rescan" : "Choose Music Folder"}</button></div></header>
      {scanProgress && <div className="scan-strip"><div style={{ width: scanProgress.total ? `${scanProgress.current / scanProgress.total * 100}%` : "12%" }} /><span>{scanProgress.phase === "discovering" ? "Finding music on your NAS…" : `Reading ${scanProgress.current} of ${scanProgress.total}${scanProgress.file ? ` · ${scanProgress.file}` : ""}`}</span></div>}
      {artworkProgress && <div className="scan-strip artwork-strip"><div style={{ width: artworkProgress.total ? `${artworkProgress.current / artworkProgress.total * 100}%` : "5%" }} /><span>{artworkProgress.status === "searching" ? "Searching" : artworkProgress.status === "found" ? "Found artwork for" : "No match for"} {artworkProgress.album} · {artworkProgress.current}/{artworkProgress.total}</span></div>}
      {notice && <button className={`notice ${notice.kind}`} onClick={() => setNotice(null)}>{notice.message}<span>×</span></button>}

      {library.albums.length === 0 && !scanProgress ? <section className="empty-state"><div className="empty-record"><span>♪</span></div><p className="eyebrow">WELCOME TO YOUR COLLECTION</p><h1>Music should feel tangible.</h1><p>{isNativeAndroid ? "Choose a music folder from Android's Files screen. Local folders and NAS shares exposed by a compatible file provider can be indexed without copying your music." : "Choose the music folder mounted from your NAS. Record Shelf builds a fast local catalogue while your original files stay exactly where they are."}</p><button onClick={() => void chooseAndScan()}>Choose Music Folder</button><small>{isNativeAndroid ? "Folder access is retained across restarts" : "Works with SMB shares mounted in Finder"}</small></section> : <>
        {view === "albums" && <section className={`collection-view layout-${albumLayout}`}><div className="section-title"><div><p className="eyebrow">{selectedArtist ? "ARTIST" : "THE RECORD SHELF"}</p><h1>{selectedArtist ?? "Albums"}</h1></div><div className="section-tools"><span>{filteredAlbums.length} albums · {filteredAlbums.flatMap((album) => album.tracks).length} songs</span>{selectedArtist && <button className="shuffle-button" onClick={() => shuffleAndPlay(selectedArtistTracks, selectedArtist)}>Shuffle Artist</button>}{selectedArtist && <button className="clear-filter-button" onClick={() => setSelectedArtist(null)}>All Albums</button>}<LayoutSwitcher value={albumLayout} onChange={setAlbumLayout} /></div></div>{albumView ?? <div className="filter-empty"><span>⌕</span><h2>No albums match</h2><p>Try another search or clear the current filter.</p><button onClick={() => { setQuery(""); setSelectedArtist(null); }}>Clear Search</button></div>}</section>}
        {view === "artists" && <section className="list-view"><div className="section-title"><div><p className="eyebrow">BROWSE</p><h1>Artists</h1></div>{!isNativeAndroid && <button className="clear-filter-button" onClick={() => void fetchAllMissingArtistArtwork()} disabled={artistArtworkBusy}>{artistArtworkBusy ? "Finding Photos…" : "Find Artist Photos"}</button>}</div><div className="artist-grid">{artists.filter((artist) => artist.name.toLowerCase().includes(query.toLowerCase())).map((artist) => { const artistAlbums = library.albums.filter((album) => album.artist === artist.name); const artistTracks = artistAlbums.flatMap((album) => album.tracks); return <article className="artist-card" key={artist.name}><button className="artist-open" onClick={() => showArtist(artist.name)} aria-label={`View albums by ${artist.name}`}><ArtistArtwork artist={artist} fallbackAlbum={artistAlbums.find((album) => album.artworkUrl !== null)} /><b title={artist.name}>{artist.name}</b><span>{artistAlbums.length} albums</span></button><button className="shuffle-button" onClick={() => shuffleAndPlay(artistTracks, artist.name)}>Shuffle</button></article>; })}</div></section>}
        {view === "genres" && <section className="list-view"><div className="section-title"><div><p className="eyebrow">BROWSE</p><h1>Genres</h1></div><span>{genreGroups.length} {genreGroups.length === 1 ? "genre" : "genres"}</span></div>{filteredGenreGroups.length ? <div className="genre-grid">{filteredGenreGroups.map((group) => { const artistNames = Array.from(new Set(group.tracks.map((track) => track.artist))); return <article className="genre-card" key={group.name}><p className="eyebrow">GENRE</p><h2>{group.name}</h2><p>{group.tracks.length} {group.tracks.length === 1 ? "song" : "songs"} · {artistNames.length} {artistNames.length === 1 ? "artist" : "artists"}</p><span>{artistNames.slice(0, 4).join(" · ")}</span><button className="shuffle-button" onClick={() => shuffleAndPlay(group.tracks, group.name)}>Shuffle {group.name}</button></article>; })}</div> : <div className="filter-empty"><span>⌕</span><h2>No genres match</h2><p>Try another search.</p><button onClick={() => setQuery("")}>Clear Search</button></div>}</section>}
        {(view === "songs" || view === "playlist") && <section className="list-view"><div className="section-title"><div><p className="eyebrow">{view === "playlist" ? "PLAYLIST" : "LIBRARY"}</p><h1>{view === "playlist" ? activePlaylist?.name : "Songs"}</h1></div><div className="playlist-title-actions"><span>{view === "playlist" ? playlistTracks.length : allTracks.length} songs</span>{view === "playlist" && activePlaylist && <button className="shuffle-button" onClick={() => shuffleAndPlay(playlistTracks, activePlaylist.name)} disabled={playlistTracks.length === 0}>Shuffle Playlist</button>}{view === "playlist" && activePlaylist && <button className="delete-playlist-button" onClick={() => setPlaylistToDelete({ id: activePlaylist.id, name: activePlaylist.name })}>Delete Playlist</button>}</div></div>{trackRows((view === "playlist" ? playlistTracks : allTracks).filter((track) => `${track.title} ${track.artist} ${track.album} ${(track.genres ?? []).join(" ")}`.toLowerCase().includes(query.toLowerCase())), view === "playlist")}</section>}
        {view === "queue" && <section className="list-view"><div className="section-title"><div><p className="eyebrow">RUNNING ORDER</p><h1>Up Next</h1></div><span>{queue.length} {queue.length === 1 ? "track" : "tracks"}</span></div>{queue.length ? trackRows(queue, false, true) : <div className="queue-empty"><span>☷</span><h2>Your queue is empty</h2><p>Use the ••• action button on any track, then choose Play Next or Add to Queue.</p></div>}</section>}
      </>}
    </main>

    <footer className="player-bar"><button className="now-playing" onClick={showNowPlayingAlbum} disabled={!currentAlbum} aria-label={currentAlbum ? `Open ${currentAlbum.title} by ${currentAlbum.artist}` : "Nothing playing"} title={currentAlbum ? "Open this album" : undefined}><Artwork album={currentAlbum} /><div><b>{currentTrack?.title ?? "Nothing playing"}</b><span>{currentTrack?.artist ?? "Choose a record"}</span></div></button><div className="transport"><div className="transport-controls"><button className={`transport-mode ${shuffleEnabled ? "active" : ""}`} onClick={toggleShuffle} disabled={allTracks.length === 0} aria-label={shuffleEnabled ? "Turn shuffle off" : "Turn shuffle on"} aria-pressed={shuffleEnabled} title={shuffleEnabled ? "Shuffle on" : "Shuffle off"}><span aria-hidden="true">⇄</span></button><button onClick={previousTrack} aria-label="Previous track" title="Previous">◀</button><button className="play" onClick={togglePlayback} aria-label={isPlaying ? "Pause" : "Play"}>{isPlaying ? "❚❚" : "▶"}</button><button onClick={nextTrack} aria-label="Next track" title="Next">▶</button><button className={`transport-mode repeat ${repeatMode !== "off" ? "active" : ""}`} onClick={cycleRepeatMode} aria-label={repeatMode === "off" ? "Repeat off. Turn on repeat all" : repeatMode === "all" ? "Repeat all. Turn on repeat one" : "Repeat one. Turn repeat off"} title={repeatMode === "off" ? "Repeat off" : repeatMode === "all" ? "Repeat all" : "Repeat one"}><span aria-hidden="true">↻</span>{repeatMode === "one" && <small aria-hidden="true">1</small>}</button></div><div className="timeline"><time>{formatTime(elapsed)}</time><input aria-label="Track position" type="range" min="0" max={currentTrack?.duration || 1} value={Math.min(elapsed, currentTrack?.duration || 1)} onChange={(event) => { audioRef.current.currentTime = Number(event.target.value); setElapsed(Number(event.target.value)); }} /><time>-{formatTime(Math.max(0, (currentTrack?.duration ?? 0) - elapsed))}</time></div></div><div className="volume"><span>◖</span><input aria-label="Volume" type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /><span>◗</span></div></footer>

    {trackMenu && <div className="track-context-menu" role="menu" style={{ left: trackMenu.x, top: trackMenu.y }} onClick={(event) => event.stopPropagation()}><div><b>{trackMenu.track.title}</b><span>{trackMenu.track.artist}</span></div><button role="menuitem" onClick={() => { playNext(trackMenu.track); setTrackMenu(null); }}>▶ Play Next</button><button role="menuitem" onClick={() => { addToQueue(trackMenu.track); setTrackMenu(null); }}>＋ Add to Queue</button><button role="menuitem" onClick={() => { openPlaylistDialog(trackMenu.track); setTrackMenu(null); }}>♫ Add to Playlist…</button></div>}

    {playlistDialog && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPlaylistDialog(null); }}><div className="playlist-dialog" role="dialog" aria-modal="true" aria-label="Playlist chooser"><button className="modal-close" onClick={() => setPlaylistDialog(null)}>×</button><p className="eyebrow">PLAYLISTS</p><h2>{playlistDialog.track ? "Add to a playlist" : "New playlist"}</h2>{playlistDialog.track && <p className="dialog-track">“{playlistDialog.track.title}” by {playlistDialog.track.artist}</p>}{playlistDialog.track && library.playlists.length > 0 && <div className="playlist-choices">{library.playlists.map((playlist) => <button key={playlist.id} onClick={() => void choosePlaylist(playlist.id)}><span>♫</span><b>{playlist.name}</b><small>{playlist.trackIds.length} songs</small></button>)}</div>}{playlistDialog.track && library.playlists.length > 0 && <div className="or"><span>or create another</span></div>}<form onSubmit={(event) => { event.preventDefault(); void createPlaylist(); }}><input autoFocus value={newPlaylistName} onChange={(event) => setNewPlaylistName(event.target.value)} placeholder="Playlist name" /><button type="submit" disabled={!newPlaylistName.trim()}>{playlistDialog.track ? "Create & Add" : "Create Playlist"}</button></form></div></div>}
    {playlistToDelete && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPlaylistToDelete(null); }}><div className="playlist-dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-playlist-title"><button className="modal-close" onClick={() => setPlaylistToDelete(null)}>×</button><p className="eyebrow">DELETE PLAYLIST</p><h2 id="delete-playlist-title">Delete “{playlistToDelete.name}”?</h2><p className="confirm-copy">This removes the playlist only. Your music files and albums will not be changed.</p><div className="confirm-actions"><button onClick={() => setPlaylistToDelete(null)}>Cancel</button><button className="danger" onClick={() => void deletePlaylist()}>Delete Playlist</button></div></div></div>}
    {nasDialog && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !nasSaving) setNasDialog(false); }}><div className="playlist-dialog nas-dialog" role="dialog" aria-modal="true" aria-labelledby="nas-settings-title"><button className="modal-close" onClick={() => setNasDialog(false)} disabled={nasSaving}>×</button><p className="eyebrow">MUSIC SOURCE</p><h2 id="nas-settings-title">Connect your NAS</h2><p className="nas-help">Enter the share once. Record Shelf will reconnect it at startup and after your computer wakes.</p><div className="nas-fields"><label><span>NAS address</span><input autoFocus value={nasForm.server} onChange={(event) => { setNasFeedback(null); setNasForm((current) => ({ ...current, server: event.target.value })); }} placeholder="nas.local or 192.168.1.20" /></label><label><span>Share name</span><input value={nasForm.share} onChange={(event) => { setNasFeedback(null); setNasForm((current) => ({ ...current, share: event.target.value })); }} placeholder="Music" /></label><label><span>Music subfolder <small>optional</small></span><input value={nasForm.subfolder} onChange={(event) => { setNasFeedback(null); setNasForm((current) => ({ ...current, subfolder: event.target.value })); }} placeholder="Library" /></label><label><span>Username</span><input value={nasForm.username} onChange={(event) => { setNasFeedback(null); setNasForm((current) => ({ ...current, username: event.target.value })); }} autoComplete="username" /></label><label><span>Password {nasHasPassword && <small>saved securely—leave blank to keep it</small>}</span><input type="password" value={nasForm.password ?? ""} onChange={(event) => { setNasFeedback(null); setNasForm((current) => ({ ...current, password: event.target.value })); }} autoComplete="current-password" placeholder={nasHasPassword ? "••••••••" : "NAS password"} /></label><label className="nas-toggle"><input type="checkbox" checked={nasForm.autoConnect} onChange={(event) => { setNasFeedback(null); setNasForm((current) => ({ ...current, autoConnect: event.target.checked })); }} /><span>Connect automatically</span></label></div>{nasFeedback && <div className={`nas-feedback ${nasFeedback.kind}`} role={nasFeedback.kind === "error" ? "alert" : "status"}><span className="nas-feedback-icon" aria-hidden="true">{nasFeedback.kind === "testing" ? "◌" : nasFeedback.kind === "success" ? "✓" : "!"}</span><div><b>{nasFeedback.title}</b><p>{nasFeedback.message}</p></div></div>}<p className="credential-note">Your password is protected by macOS Keychain or Windows account encryption. It is never stored in the music catalogue.</p><div className="confirm-actions"><button onClick={() => void useLocalFolder()} disabled={nasSaving}>Use Local Folder</button>{nasFeedback?.kind === "success" && <button onClick={() => setNasDialog(false)}>Done</button>}<button className="primary" onClick={() => void saveNasSettings()} disabled={nasSaving || !nasForm.server.trim() || !nasForm.share.trim()}>{nasSaving ? "Testing…" : nasFeedback?.kind === "success" ? "Test Again" : "Save & Test Connection"}</button></div></div></div>}
  </div>;
}
