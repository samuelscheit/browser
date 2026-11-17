import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { CdpConnectError, CdpConnection } from "@browser-fabric/worker-runtime";
import type { BrowserBackend } from "./backend";
import { portListening, readDevToolsActivePort } from "./devtools-active-port";

export const REMOTE_DEBUGGING_PAGE = "chrome://inspect/#remote-debugging";
export const ALLOW_NOTICE = "Chrome asks “Allow remote debugging?”: click Allow (once while fabric runs).";
export const ENABLE_NOTICE = `Remote debugging is off in your Chrome: in the ${REMOTE_DEBUGGING_PAGE} tab fabric opened, enable it (once; Chrome remembers it).`;
/** After a declined prompt, clients that retry at once get the refusal instead of another prompt. */
const DECLINED_COOLDOWN_MS = 30_000;

/** How to find, start and prompt the user's everyday Chrome on this platform. */
export interface SystemChrome {
  userDataDir: string;
  isRunning(): boolean;
  /** Start Chrome the way the user does, without debugging flags (they are ignored on this profile anyway). */
  start(): void;
  openRemoteDebuggingPage(): void;
}

function detached(command: string, args: string[]): void {
  spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
}

export function systemChrome(platform = process.platform, home = homedir()): SystemChrome {
  if (platform === "darwin") {
    return {
      userDataDir: join(home, "Library/Application Support/Google/Chrome"),
      isRunning: () => spawnSync("pgrep", ["-x", "Google Chrome"]).status === 0,
      start: () => detached("open", ["-a", "Google Chrome"]),
      openRemoteDebuggingPage: () => detached("open", ["-a", "Google Chrome", REMOTE_DEBUGGING_PAGE]),
    };
  }
  if (platform === "linux") {
    return {
      userDataDir: join(home, ".config/google-chrome"),
      isRunning: () => spawnSync("pgrep", ["-x", "chrome"]).status === 0,
      start: () => detached("google-chrome", []),
      openRemoteDebuggingPage: () => detached("google-chrome", [REMOTE_DEBUGGING_PAGE]),
    };
  }
  throw new Error(`fabric cannot use your own Chrome on ${platform}; use --profile <name> for a Chrome fabric starts itself`);
}

export interface SystemChromeBackendOptions {
  chrome?: SystemChrome;
  log?: (message: string) => void;
  /** What the user must do now (enable the toggle, click Allow); undefined once done. */
  notify?: (notice: string | undefined) => void;
  /** How long to wait for Chrome to start and for the user to enable remote debugging. */
  enableTimeoutMs?: number;
  /** How long the one connection waits for the user to answer "Allow remote debugging?". */
  approvalTimeoutMs?: number;
  /** After `start()`, how long Chrome may take to open its debugging server before fabric asks for the toggle. */
  startupGraceMs?: number;
}

/**
 * The user's everyday Chrome, with their real profile, through Chrome's own remote-debugging
 * toggle (Chrome 144+). Chrome ignores `--remote-debugging-port` on the default profile since
 * 136, so fabric never restarts it with flags: Chrome publishes its debugging server in
 * DevToolsActivePort, and every WebSocket to it needs the user's "Allow" click, which is why the
 * endpoint keeps exactly one. Nothing here ever quits Chrome or closes the user's tabs: closing the
 * connection only detaches.
 */
export class SystemChromeBackend implements BrowserBackend {
  readonly guardian = "agent-tabs" as const;
  readonly #options: SystemChromeBackendOptions;
  readonly #chrome: SystemChrome;
  #remoteDebuggingPageOpened = false;
  #refusal?: { error: Error; until: number };
  #notice?: string;

  public constructor(options: SystemChromeBackendOptions = {}) {
    this.#options = options;
    this.#chrome = options.chrome ?? systemChrome();
  }

  public describe() {
    return { profile: this.#chrome.userDataDir, detail: `your Chrome (${this.#chrome.userDataDir}) via ${REMOTE_DEBUGGING_PAGE}` };
  }

  public async connect(): Promise<CdpConnection> {
    if (this.#refusal && Date.now() < this.#refusal.until) throw this.#refusal.error;
    const endpoint = await this.#endpoint();
    const approvalTimeoutMs = this.#options.approvalTimeoutMs ?? 180_000;
    this.#notify(ALLOW_NOTICE);
    try {
      const connection = await CdpConnection.connect({ endpoint, timeoutMs: approvalTimeoutMs });
      this.#options.log?.(`connected to your Chrome at ${endpoint}`);
      return connection;
    } catch (error) {
      if (error instanceof CdpConnectError && error.status === 403) {
        const declined = new Error("Chrome refused the connection: “Allow remote debugging?” was declined. Run the command again and click Allow.");
        this.#refusal = { error: declined, until: Date.now() + DECLINED_COOLDOWN_MS };
        throw declined;
      }
      if (error instanceof CdpConnectError && error.timedOut) {
        throw new Error(`Nobody answered Chrome's “Allow remote debugging?” prompt within ${Math.round(approvalTimeoutMs / 1000)} s. Run the command again and click Allow in Chrome.`);
      }
      throw new Error(`Cannot connect to your Chrome at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.#notify(undefined);
    }
  }

  /** Local Chrome stays connected until `fabric down` (and only detaches then). */
  public async close(): Promise<void> {}

  #notify(notice: string | undefined): void {
    if (notice === this.#notice) return;
    this.#notice = notice;
    if (notice) this.#options.log?.(notice);
    this.#options.notify?.(notice);
  }

  /** Wait until Chrome runs with its debugging server on; start Chrome and ask for the toggle as needed. */
  async #endpoint(): Promise<string> {
    const deadline = Date.now() + (this.#options.enableTimeoutMs ?? 180_000);
    const grace = this.#options.startupGraceMs ?? 10_000;
    let startedAt: number | undefined;
    try {
      for (;;) {
        const active = readDevToolsActivePort(this.#chrome.userDataDir);
        if (active && await portListening(active.port)) return `ws://127.0.0.1:${active.port}${active.path}`;
        const running = this.#chrome.isRunning();
        if (!running && startedAt === undefined) {
          this.#options.log?.("starting your Chrome");
          this.#chrome.start();
          startedAt = Date.now();
        } else if (!running && Date.now() - startedAt! > 30_000) {
          throw new Error("Your Chrome did not start within 30 s. Start Google Chrome and run the command again.");
        } else if (running && (startedAt === undefined || Date.now() - startedAt > grace)) {
          if (!this.#remoteDebuggingPageOpened) {
            this.#remoteDebuggingPageOpened = true;
            this.#chrome.openRemoteDebuggingPage();
          }
          this.#notify(ENABLE_NOTICE);
        }
        if (Date.now() > deadline) {
          throw new Error(`Remote debugging is off in your Chrome. Open ${REMOTE_DEBUGGING_PAGE}, enable it, and run the command again (Chrome 144 or newer).`);
        }
        await Bun.sleep(250);
      }
    } finally {
      this.#notify(undefined);
    }
  }
}
