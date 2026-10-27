import { safeStorage } from "electron";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type NasSettings = {
  server: string;
  share: string;
  subfolder: string;
  username: string;
  autoConnect: boolean;
  hasPassword: boolean;
};

export type NasSettingsInput = Omit<NasSettings, "hasPassword"> & { password?: string; clearPassword?: boolean };
export type ConnectionStatus = { state: "local" | "connecting" | "connected" | "offline"; message: string; root: string | null };

const defaults: NasSettings = { server: "", share: "", subfolder: "", username: "", autoConnect: true, hasPassword: false };
const cleanPart = (value: string) => value.trim().replace(/^smb:\/\//i, "").replace(/^[/\\]+|[/\\]+$/g, "");
const appleString = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const powershellString = (value: string) => `'${value.replace(/'/g, "''")}'`;
const existsDirectory = async (candidate: string) => (await stat(candidate).catch(() => null))?.isDirectory() === true;

async function runWithStdin(command: string, args: string[], input: string, timeoutMs = 20_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Connection timed out")); }, timeoutMs);
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(stderr.trim() || "The NAS connection was refused"));
    });
    child.stdin.end(input);
  });
}

export class NasConnectionManager {
  private status: ConnectionStatus = { state: "local", message: "Using a local or already mounted folder", root: null };
  private connecting: Promise<ConnectionStatus> | null = null;

  constructor(private readonly settingsPath: string, private readonly passwordPath: string) {}

  getStatus(): ConnectionStatus { return this.status; }

  async getSettings(): Promise<NasSettings> {
    const stored = await readFile(this.settingsPath, "utf8").then((value) => JSON.parse(value) as Partial<NasSettings>).catch(() => ({}));
    const hasPassword = await readFile(this.passwordPath).then((value) => value.length > 0).catch(() => false);
    return { ...defaults, ...stored, hasPassword };
  }

  async saveSettings(input: NasSettingsInput): Promise<NasSettings> {
    const current = await this.getSettings();
    const server = cleanPart(input.server);
    const share = cleanPart(input.share);
    const subfolder = cleanPart(input.subfolder).replace(/\\/g, "/");
    if (/[\\/]/.test(server)) throw new Error("Enter only the NAS name or IP address, without smb:// or a folder path.");
    if (/[\\/]/.test(share)) throw new Error("The share name must be a single folder name.");
    if (subfolder.split("/").some((part) => part === "..")) throw new Error("The music subfolder cannot contain '..'.");
    const settings: NasSettings = {
      server, share, subfolder,
      username: input.username.trim(), autoConnect: input.autoConnect, hasPassword: current.hasPassword,
    };
    await mkdir(path.dirname(this.settingsPath), { recursive: true });
    if ((!server && !share) || input.clearPassword) {
      await rm(this.passwordPath, { force: true });
      settings.hasPassword = false;
    }
    if (typeof input.password === "string" && input.password.length > 0) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure password storage is unavailable on this computer.");
      await writeFile(this.passwordPath, safeStorage.encryptString(input.password), { mode: 0o600 });
      settings.hasPassword = true;
    }
    await writeFile(this.settingsPath, JSON.stringify({ ...settings, hasPassword: undefined }, null, 2), { mode: 0o600 });
    return settings;
  }

  private async password(): Promise<string> {
    const encrypted = await readFile(this.passwordPath).catch(() => null);
    return encrypted ? safeStorage.decryptString(encrypted) : "";
  }

  private async macRoot(settings: NasSettings): Promise<string | null> {
    const volumes = await readdir("/Volumes").catch(() => [] as string[]);
    const shareKey = settings.share.toLocaleLowerCase();
    for (const volume of volumes) {
      if (volume.toLocaleLowerCase() !== shareKey && !volume.toLocaleLowerCase().startsWith(`${shareKey}-`)) continue;
      const candidate = path.join("/Volumes", volume, settings.subfolder);
      if (await existsDirectory(candidate)) return candidate;
    }
    return null;
  }

  async connect(force = false): Promise<ConnectionStatus> {
    if (this.connecting) return this.connecting;
    this.connecting = this.performConnect(force).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async performConnect(force: boolean): Promise<ConnectionStatus> {
    const settings = await this.getSettings();
    if (!settings.server || !settings.share) return this.status = { state: "local", message: "Using a local or already mounted folder", root: null };
    if (!force && !settings.autoConnect) return this.status = { state: "offline", message: "Automatic NAS connection is turned off", root: null };
    this.status = { state: "connecting", message: "Connecting to music library…", root: null };
    try {
      if (process.platform === "darwin") {
        const existing = await this.macRoot(settings);
        if (existing) return this.status = { state: "connected", message: "NAS connected", root: existing };
        const password = await this.password();
        const address = `smb://${settings.server}/${settings.share}`;
        let script = `mount volume ${appleString(address)}`;
        if (settings.username) script += ` as user name ${appleString(settings.username)}`;
        if (password) script += ` with password ${appleString(password)}`;
        await runWithStdin("/usr/bin/osascript", [], `${script}\n`);
        const root = await this.macRoot(settings);
        if (!root) throw new Error("The share connected but its music folder was not found");
        return this.status = { state: "connected", message: "NAS connected", root };
      }
      if (process.platform === "win32") {
        const shareRoot = `\\\\${settings.server}\\${settings.share}`;
        const root = settings.subfolder ? `${shareRoot}\\${settings.subfolder.replace(/\//g, "\\")}` : shareRoot;
        if (!(await existsDirectory(root))) {
          const password = await this.password();
          const credentialArguments = settings.username || password
            ? ` -UserName ${powershellString(settings.username)} -Password ${powershellString(password)}`
            : "";
          const script = `$remote=${powershellString(shareRoot)}\nNew-SmbMapping -RemotePath $remote${credentialArguments} -Persistent $true -ErrorAction Stop | Out-Null\n`;
          await runWithStdin("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], script);
        }
        if (!(await existsDirectory(root))) throw new Error("The NAS connected but its music folder was not found");
        return this.status = { state: "connected", message: "NAS connected", root };
      }
      throw new Error("Automatic NAS connection is currently supported on macOS and Windows");
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/smb:\/\/[^\s]+/gi, "the NAS") : "NAS unavailable";
      return this.status = { state: "offline", message, root: null };
    }
  }
}
