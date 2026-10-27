export type Track = {
  id: number; albumId: string; path: string; title: string; artist: string; album: string; albumArtist: string;
  trackNumber: number; discNumber: number; duration: number; year: number | null; genres: string[];
};
export type Album = { id: string; title: string; artist: string; year: number | null; artworkUrl: string | null; artworkSource: "embedded" | "folder" | "musicbrainz" | null; tracks: Track[] };
export type Artist = { name: string; imageUrl: string | null; imageSource: "wikimedia" | null };
export type Playlist = { id: string; name: string; trackIds: number[] };
export type Library = { root: string | null; albums: Album[]; artists: Artist[]; playlists: Playlist[] };
export type ScanProgress = { phase: "discovering" | "reading" | "finishing"; current: number; total: number; file?: string };
export type ArtworkProgress = { current: number; total: number; album: string; status: "searching" | "found" | "missing" | "error" };
export type ArtworkResult = { success: boolean; message: string; albumId: string };
export type NasSettings = { server: string; share: string; subfolder: string; username: string; autoConnect: boolean; hasPassword: boolean };
export type NasSettingsInput = Omit<NasSettings, "hasPassword"> & { password?: string };
export type ConnectionStatus = { state: "local" | "connecting" | "connected" | "offline"; message: string; root: string | null };

declare global {
  interface Window {
    recordShelf: {
      getLibrary(): Promise<Library>;
      chooseFolder(): Promise<string | null>;
      scanFolder(root: string): Promise<Library>;
      getNasSettings(): Promise<NasSettings>;
      getConnectionStatus(): Promise<ConnectionStatus>;
      saveNasSettings(settings: NasSettingsInput): Promise<{ settings: NasSettings; status: ConnectionStatus; library: Library }>;
      connectNas(): Promise<{ status: ConnectionStatus; library: Library }>;
      createPlaylist(name: string): Promise<Playlist>;
      deletePlaylist(playlistId: string): Promise<Library>;
      addToPlaylist(playlistId: string, trackId: number): Promise<Library>;
      removeFromPlaylist(playlistId: string, trackId: number): Promise<Library>;
      fetchAlbumArtwork(albumId: string): Promise<{ result: ArtworkResult; library: Library }>;
      fetchMissingArtwork(): Promise<{ result: { found: number; missing: number }; library: Library }>;
      fetchArtistArtwork(artist: string): Promise<{ result: ArtworkResult; library: Library }>;
      fetchMissingArtistArtwork(): Promise<{ result: { found: number; missing: number }; library: Library }>;
      onScanProgress(callback: (progress: ScanProgress) => void): () => void;
      onChooseLibrary(callback: () => void): () => void;
      onPlayerCommand(callback: (command: "toggle" | "next" | "previous" | "stop") => void): () => void;
      onArtworkProgress(callback: (progress: ArtworkProgress) => void): () => void;
      onConnectionStatus(callback: (status: ConnectionStatus) => void): () => void;
    };
  }
}
