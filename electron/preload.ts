import { contextBridge, ipcRenderer } from "electron";
import type { ArtworkProgress, ScanProgress } from "./library.js";

contextBridge.exposeInMainWorld("recordShelf", {
  getLibrary: () => ipcRenderer.invoke("library:snapshot"),
  chooseFolder: () => ipcRenderer.invoke("library:choose-folder"),
  scanFolder: (root: string) => ipcRenderer.invoke("library:scan", root),
  createPlaylist: (name: string) => ipcRenderer.invoke("playlist:create", name),
  deletePlaylist: (playlistId: string) => ipcRenderer.invoke("playlist:delete", playlistId),
  addToPlaylist: (playlistId: string, trackId: number) => ipcRenderer.invoke("playlist:add-track", playlistId, trackId),
  removeFromPlaylist: (playlistId: string, trackId: number) => ipcRenderer.invoke("playlist:remove-track", playlistId, trackId),
  fetchAlbumArtwork: (albumId: string) => ipcRenderer.invoke("artwork:fetch-album", albumId),
  fetchMissingArtwork: () => ipcRenderer.invoke("artwork:fetch-missing"),
  onScanProgress: (callback: (progress: ScanProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ScanProgress) => callback(progress);
    ipcRenderer.on("library:scan-progress", listener);
    return () => ipcRenderer.removeListener("library:scan-progress", listener);
  },
  onChooseLibrary: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("library:choose", listener);
    return () => ipcRenderer.removeListener("library:choose", listener);
  },
  onPlayerCommand: (callback: (command: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: string) => callback(command);
    ipcRenderer.on("player:command", listener);
    return () => ipcRenderer.removeListener("player:command", listener);
  },
  onArtworkProgress: (callback: (progress: ArtworkProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ArtworkProgress) => callback(progress);
    ipcRenderer.on("artwork:progress", listener);
    return () => ipcRenderer.removeListener("artwork:progress", listener);
  },
});
