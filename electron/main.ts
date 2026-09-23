import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, net, protocol } from "electron";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MusicLibrary, type ArtworkProgress, type ScanProgress } from "./library.js";

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

  protocol.handle("music-file", (request) => {
    const url = new URL(request.url);
    const id = Number(url.pathname.slice(1));
    const filePath = library.getTrackPath(id);
    return filePath ? net.fetch(pathToFileURL(filePath).href, { headers: request.headers }) : new Response("Track not found", { status: 404 });
  });
  protocol.handle("music-art", (request) => {
    const url = new URL(request.url);
    const albumId = decodeURIComponent(url.pathname.slice(1));
    const filePath = library.getArtworkPath(albumId);
    return filePath ? net.fetch(pathToFileURL(filePath).href) : new Response("Artwork not found", { status: 404 });
  });

  ipcMain.handle("library:snapshot", () => library.snapshot());
  ipcMain.handle("library:choose-folder", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"], title: "Choose your NAS music folder" });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("library:scan", async (_event, root: string) => {
    await library.scan(root, (progress: ScanProgress) => mainWindow?.webContents.send("library:scan-progress", progress));
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

  createMenu();
  await createWindow();
  globalShortcut.register("MediaPlayPause", () => sendPlayerCommand("toggle"));
  globalShortcut.register("MediaNextTrack", () => sendPlayerCommand("next"));
  globalShortcut.register("MediaPreviousTrack", () => sendPlayerCommand("previous"));
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
