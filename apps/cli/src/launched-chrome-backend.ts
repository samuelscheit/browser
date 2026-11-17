import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CdpConnection, closeBrowserGracefully } from "@browser-fabric/worker-runtime";
import type { BrowserBackend } from "./backend";
import { localProfileDirectory, type BrowserRequest } from "./config";
import { readDevToolsActivePort } from "./devtools-active-port";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findChrome(explicit?: string): string {
  const candidates = explicit ? [explicit] : [process.env.FABRIC_CHROME, ...CHROME_CANDIDATES].filter((value): value is string => Boolean(value));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(explicit ? `Chrome not found at ${explicit}` : "No Chrome or Chromium found. Install Google Chrome or pass --chrome <path>.");
  return found;
}

export function chromeArguments(profileDirectory: string, headless: boolean): string[] {
  return [
    `--user-data-dir=${profileDirectory}`,
    // Port 0 lets Chromium pick a free port and publish it in DevToolsActivePort.
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=ChromeWhatsNewUI",
    ...(headless ? ["--headless=new", "--window-size=1280,800"] : []),
    "about:blank",
  ];
}

export interface LaunchedChromeBackendOptions {
  request: BrowserRequest & { profile: string };
  home?: string;
  startupTimeoutMs?: number;
  log?: (message: string) => void;
}

/**
 * A Chrome fabric starts itself with a separate profile (`--profile <name>` or `--headless`):
 * isolated from the user's browser, and owned by fabric, so `fabric down` quits it.
 */
export class LaunchedChromeBackend implements BrowserBackend {
  readonly owner = "fabric" as const;
  readonly guardian = true;
  readonly #options: LaunchedChromeBackendOptions;
  readonly #profileDirectory: string;
  #process?: ChildProcess;
  #endpoint?: string;
  #starting?: Promise<string>;

  public constructor(options: LaunchedChromeBackendOptions) {
    this.#options = options;
    this.#profileDirectory = localProfileDirectory(options.request.profile, options.home);
  }

  public describe() {
    return {
      profile: this.#profileDirectory,
      detail: this.#process ? `fabric's Chrome pid ${this.#process.pid} (profile ${this.#profileDirectory})` : "fabric's Chrome is not running; the next client starts it",
    };
  }

  public async connect(): Promise<CdpConnection> {
    const running = this.#endpoint && this.#process && this.#process.exitCode === null && this.#process.signalCode === null;
    if (!running) {
      this.#starting ??= this.#launch().finally(() => { this.#starting = undefined; });
      await this.#starting;
    }
    return CdpConnection.connect({ endpoint: this.#endpoint!, timeoutMs: 30_000 });
  }

  public async close(): Promise<void> {
    const child = this.#process;
    const endpoint = this.#endpoint;
    this.#process = undefined;
    this.#endpoint = undefined;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // SIGTERM skips Chromium's cookie flush; a CDP close keeps fresh logins in the profile.
    if (endpoint && await closeBrowserGracefully(endpoint)) await Promise.race([exited, Bun.sleep(5_000)]);
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(timer);
  }

  async #launch(): Promise<string> {
    const chrome = findChrome(this.#options.request.chrome);
    mkdirSync(this.#profileDirectory, { recursive: true, mode: 0o700 });
    rmSync(join(this.#profileDirectory, "DevToolsActivePort"), { force: true });
    const child = spawn(chrome, chromeArguments(this.#profileDirectory, this.#options.request.headless), { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4_000); });
    child.once("exit", (code, signal) => {
      this.#options.log?.(`fabric's Chrome exited (${signal ?? code})`);
      if (this.#process === child) {
        this.#process = undefined;
        this.#endpoint = undefined;
      }
    });
    this.#process = child;
    const deadline = Date.now() + (this.#options.startupTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Chrome exited during startup (${child.signalCode ?? child.exitCode}). If this profile is already open in another Chrome window, close it first. ${stderr.trim()}`.trim());
      }
      const active = readDevToolsActivePort(this.#profileDirectory);
      if (active) {
        this.#endpoint = `ws://127.0.0.1:${active.port}${active.path}`;
        this.#options.log?.(`fabric's Chrome ${child.pid} listening on ${this.#endpoint}`);
        return this.#endpoint;
      }
      await Bun.sleep(100);
    }
    child.kill("SIGKILL");
    throw new Error(`Chrome did not open its DevTools port within ${Math.round((this.#options.startupTimeoutMs ?? 30_000) / 1000)} s. ${stderr.trim()}`.trim());
  }
}
