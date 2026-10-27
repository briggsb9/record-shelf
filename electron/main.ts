import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, net, powerMonitor, protocol } from "electron";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MusicLibrary, type ArtworkProgress, type ScanProgress } from "./library.js";
import { NasConnectionManager, type ConnectionStatus, type NasSettingsInput } from "./nas.js";

protocol.registerSchemesAsPrivileged([
  { scheme: "music-file", privileges: { standard: true, secure: true, corsEnabled: true, supportFetchAPI: true, stream: true } },
  { scheme: "music-art", privileges: { standard: true, secure: true, corsEnabled: true, supportFetchAPI: true } },
]);

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const applicationDataDirectory = app.getPath("appData");
app.setPath(
  "userData",
  app.isPackaged
    ? path.join(applicationDataDirectory, "Record Shelf")
    : path.join(currentDirectory, "../.dev-data"),
);
let mainWindow: BrowserWindow | null = null;
let library: MusicLibrary;
let nas: NasConnectionManager;
let reconnectTimer: NodeJS.Timeout | null = null;
let connectionStatus: ConnectionStatus = { state: "local", message: "Using a local or already mounted folder", root: null };

async function connectNas(force = false): Promise<ConnectionStatus> {
  let status = await nas.connect(force);
  if (status.root) library.setLibraryRoot(status.root);
  if (status.state === "local") {
    const root = library.getLibraryRoot();
    if (root && !(await stat(root).catch(() => null))?.isDirectory()) {
      status = { state: "offline", message: "The saved music folder is unavailable. Open Music Source settings to reconnect it.", root: null };
    }
  }
  connectionStatus = status;
  mainWindow?.webContents.send("nas:status", status);
  return status;
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearInterval(reconnectTimer);
  reconnectTimer = setInterval(() => {
    void connectNas();
  }, 30_000);
}

function sendPlayerCommand(command: "toggle" | "next" | "previous" | "stop"): void {
  mainWindow?.webContents.send("player:command", command);
}

function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "Choose Music Folder…", accelerator: "CmdOrCtrl+O", click: () => mainWindow?.webContents.send("library:choose") },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Playback",
      submenu: [
        { label: "Play/Pause", click: () => sendPlayerCommand("toggle") },
        { label: "Next Track", accelerator: "CmdOrCtrl+Right", click: () => sendPlayerCommand("next") },
        { label: "Previous Track", accelerator: "CmdOrCtrl+Left", click: () => sendPlayerCommand("previous") },
        { label: "Stop", accelerator: "CmdOrCtrl+.", click: () => sendPlayerCommand("stop") },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 940,
    minHeight: 650,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: "#171713",
    webPreferences: {
      preload: path.join(currentDirectory, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) await mainWindow.loadURL(developmentUrl);
  else await mainWindow.loadFile(path.join(currentDirectory, "../dist/index.html"));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  const artworkDirectory = path.join(userData, "artwork");
  await mkdir(artworkDirectory, { recursive: true });
  library = new MusicLibrary(path.join(userData, "library.sqlite"), artworkDirectory);
  nas = new NasConnectionManager(path.join(userData, "nas-source.json"), path.join(userData, "nas-password.bin"));

  protocol.handle("music-file", async (request) => {
    const url = new URL(request.url);
    const id = Number(url.pathname.slice(1));
    await connectNas();
    const filePath = library.getTrackPath(id);
    return filePath ? net.fetch(pathToFileURL(filePath).href, { headers: request.headers }) : new Response("Track not found", { status: 404 });
  });
  protocol.handle("music-art", (request) => {
    const url = new URL(request.url);
    const resourceId = decodeURIComponent(url.pathname.slice(1));
    const filePath = url.hostname === "artist" ? library.getArtistImagePath(resourceId) : library.getArtworkPath(resourceId);
    return filePath ? net.fetch(pathToFileURL(filePath).href) : new Response("Artwork not found", { status: 404 });
  });

  ipcMain.handle("library:snapshot", () => library.snapshot());
  ipcMain.handle("nas:settings", () => nas.getSettings());
  ipcMain.handle("nas:status", () => connectionStatus);
  ipcMain.handle("nas:save", async (_event, settings: NasSettingsInput) => {
    await nas.saveSettings(settings);
    const status = await connectNas(true);
    return { settings: await nas.getSettings(), status, library: library.snapshot() };
  });
  ipcMain.handle("nas:connect", async () => {
    const status = await connectNas(true);
    return { status, library: library.snapshot() };
  });
  ipcMain.handle("library:choose-folder", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"], title: "Choose your NAS music folder" });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("library:scan", async (_event, root: string) => {
    await library.scan(root, (progress: ScanProgress) => mainWindow?.webContents.send("library:scan-progress", progress));
    await connectNas(true);
    return library.snapshot();
  });
  ipcMain.handle("playlist:create", (_event, name: string) => library.createPlaylist(name));
  ipcMain.handle("playlist:delete", (_event, playlistId: string) => {
    library.deletePlaylist(playlistId);
    return library.snapshot();
  });
  ipcMain.handle("playlist:add-track", (_event, playlistId: string, trackId: number) => {
    library.addToPlaylist(playlistId, trackId);
    return library.snapshot();
  });
  ipcMain.handle("playlist:remove-track", (_event, playlistId: string, trackId: number) => {
    library.removeFromPlaylist(playlistId, trackId);
    return library.snapshot();
  });
  ipcMain.handle("artwork:fetch-album", async (_event, albumId: string) => {
    const result = await library.fetchAlbumArtwork(albumId);
    return { result, library: library.snapshot() };
  });
  ipcMain.handle("artwork:fetch-missing", async () => {
    const result = await library.fetchMissingArtwork((progress: ArtworkProgress) => mainWindow?.webContents.send("artwork:progress", progress));
    return { result, library: library.snapshot() };
  });
  ipcMain.handle("artwork:fetch-artist", async (_event, artist: string) => {
    const result = await library.fetchArtistArtwork(artist);
    return { result, library: library.snapshot() };
  });
  ipcMain.handle("artwork:fetch-missing-artists", async () => {
    const result = await library.fetchMissingArtistArtwork((progress: ArtworkProgress) => mainWindow?.webContents.send("artwork:progress", progress));
    return { result, library: library.snapshot() };
  });

  createMenu();
  await createWindow();
  void connectNas().then(() => scheduleReconnect());
  powerMonitor.on("resume", () => { void connectNas(); });
  globalShortcut.register("MediaPlayPause", () => sendPlayerCommand("toggle"));
  globalShortcut.register("MediaNextTrack", () => sendPlayerCommand("next"));
  globalShortcut.register("MediaPreviousTrack", () => sendPlayerCommand("previous"));
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on("will-quit", () => { globalShortcut.unregisterAll(); if (reconnectTimer) clearInterval(reconnectTimer); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
