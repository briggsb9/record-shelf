import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { ArtworkProgress, ArtworkResult, Library, Playlist, ScanProgress, Track } from "./types";

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
  getTrackUrl(options: { trackId: number }): Promise<{ url: string }>;
  addListener(eventName: "scanProgress", listener: (progress: ScanProgress) => void): Promise<PluginListenerHandle>;
};

const NativeRecordShelf = registerPlugin<NativeRecordShelfPlugin>("RecordShelf");
export const isNativeAndroid = Capacitor.getPlatform() === "android";

function normaliseLibrary(library: Library): Library {
  if (!isNativeAndroid) return library;
  return {
    ...library,
    albums: library.albums.map((album) => ({
      ...album,
      artworkUrl: album.artworkUrl ? Capacitor.convertFileSrc(album.artworkUrl) : null,
    })),
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
  onScanProgress: (callback) => nativeListener("scanProgress", callback),
  onArtworkProgress: (_callback: (progress: ArtworkProgress) => void) => () => undefined,
  onChooseLibrary: () => () => undefined,
  onPlayerCommand: () => () => undefined,
};

export const recordShelf: Window["recordShelf"] = window.recordShelf ?? mobileBridge;

export async function trackPlaybackUrl(track: Track): Promise<string> {
  if (!isNativeAndroid) return `music-file://track/${track.id}`;
  const { url } = await NativeRecordShelf.getTrackUrl({ trackId: track.id });
  return Capacitor.convertFileSrc(url);
}
