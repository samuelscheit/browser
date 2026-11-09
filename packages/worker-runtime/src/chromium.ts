import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { BrowserContainerSpec } from "./index";
import type { TokenCaptchaSolver } from "./captcha-solvers/types";
import { FabricError } from "@browser-fabric/contracts";
import { assertFailClosedPac } from "@browser-fabric/policy";
import { closeBrowserGracefully } from "./cdp-connection";
import {
  assertTurnstileGuardianSpec,
  defaultTurnstileGuardianFactory,
  turnstileGuardianSpecFromEnvironment,
  type TurnstileGuardianFactory,
  type TurnstileGuardianHandle,
  type TurnstileGuardianSnapshot,
} from "./turnstile-guardian";

export interface ChromiumLaunchResult {
  processId: string;
  cdpBrowserEndpoint: string;
  pid?: number;
}

export interface ChromiumProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: string, listener: (...args: unknown[]) => void): this;
}

export interface ChromiumSpawner {
  spawn(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] }): ChromiumProcess;
}

/** Fetch surface used by the supervisor; intentionally narrower than Bun's extended `fetch`. */
export type ChromiumFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const defaultSpawner: ChromiumSpawner = { spawn: (command, args, options) => spawn(command, [...args], options) as unknown as ChromiumProcess };

function waitForExit(process: ChromiumProcess): Promise<void> {
  return new Promise((resolve) => process.once("exit", () => resolve()));
}

function commandPath(spec: BrowserContainerSpec, configuredPath?: string): string {
  const command = spec.command[0];
  const expected = configuredPath ?? "/usr/bin/chromium";
  // Generic recipes use the pinned Linux path. A federated local agent may substitute its
  // explicitly configured host binary; it cannot substitute an arbitrary path from a job.
  if (!command || (command !== expected && !(configuredPath && command === "/usr/bin/chromium"))) throw new FabricError("validation_failed", "worker may launch only the pinned Chromium executable", 400);
  return expected;
}

async function pollVersion(endpoint: string, timeoutMs: number, fetcher: ChromiumFetcher, cancelled: () => boolean = () => false): Promise<{ webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (cancelled()) throw new FabricError("worker_unavailable", "Chromium startup was cancelled", 503);
    try {
      const response = await fetcher(`${endpoint}/json/version`, { signal: AbortSignal.timeout(Math.min(1_000, Math.max(100, deadline - Date.now()))) });
      if (response.ok) {
        const body = await response.json() as { webSocketDebuggerUrl?: unknown };
        if (typeof body.webSocketDebuggerUrl === "string" && body.webSocketDebuggerUrl.startsWith("ws://127.0.0.1:")) return { webSocketDebuggerUrl: body.webSocketDebuggerUrl };
        lastError = new Error("Chromium returned no loopback websocket debugger URL");
      } else lastError = new Error(`Chromium status ${response.status}`);
    } catch (error) { lastError = error; }
    await Bun.sleep(50);
  }
  throw new FabricError("worker_unavailable", `Chromium did not expose CDP within ${timeoutMs}ms${lastError instanceof Error ? `: ${lastError.message}` : ""}`, 503);
}

/** Launches one dedicated browser process for one Fabric lease. */
export class ChromiumProcessSupervisor {
  readonly #processes = new Map<string, ChromiumProcess>();
  readonly #starting = new Map<string, Promise<ChromiumLaunchResult>>();
  /** Cooperative cancellation for a stop racing browser/guardian startup. */
  readonly #cancelled = new Set<string>();
  readonly #guardians = new Map<string, TurnstileGuardianHandle>();
  readonly #browserEndpoints = new Map<string, string>();
  readonly #closeBrowser: typeof closeBrowserGracefully;
  readonly #spawner: ChromiumSpawner;
  readonly #guardianFactory: TurnstileGuardianFactory;
  readonly #tokenSolverFor?: (handlers: BrowserContainerSpec["challengeHandlers"]) => TokenCaptchaSolver | undefined;
  readonly #fetch: ChromiumFetcher;
  readonly #cwd: string;
  readonly #startupTimeoutMs: number;
  readonly #executablePath?: string;
  readonly #profileRoot?: string;

  public constructor(options: {
    spawner?: ChromiumSpawner;
    fetch?: ChromiumFetcher;
    cwd?: string;
    startupTimeoutMs?: number;
    executablePath?: string;
    profileRoot?: string;
    turnstileGuardianFactory?: TurnstileGuardianFactory;
    /** Orderly browser shutdown before signals. Tests inject a fake. */
    closeBrowser?: typeof closeBrowserGracefully;
    /** Resolves a recipe's token solver for a locally supervised browser. Absent means no solver. */
    tokenSolverFor?: (handlers: BrowserContainerSpec["challengeHandlers"]) => TokenCaptchaSolver | undefined;
  } = {}) {
    this.#spawner = options.spawner ?? defaultSpawner;
    this.#guardianFactory = options.turnstileGuardianFactory ?? defaultTurnstileGuardianFactory;
    this.#closeBrowser = options.closeBrowser ?? closeBrowserGracefully;
    this.#tokenSolverFor = options.tokenSolverFor;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#cwd = options.cwd ?? "/tmp";
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
    this.#executablePath = options.executablePath;
    this.#profileRoot = options.profileRoot;
  }

  public async start(spec: BrowserContainerSpec): Promise<ChromiumLaunchResult> {
    const processId = `${spec.workerId}:${spec.leaseId ?? spec.jobId ?? crypto.randomUUID()}`;
    const pending = this.#starting.get(processId);
    if (pending) return pending;
    if (this.#processes.has(processId)) throw new FabricError("conflict", "a browser process already exists for this lease", 409);
    this.#cancelled.delete(processId);
    const task = this.#start(spec, processId);
    this.#starting.set(processId, task);
    try {
      return await task;
    } finally {
      if (this.#starting.get(processId) === task) this.#starting.delete(processId);
    }
  }

  async #start(spec: BrowserContainerSpec, processId: string): Promise<ChromiumLaunchResult> {
    const command = commandPath(spec, this.#executablePath);
    const port = spec.cdpBind.port;
    if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new FabricError("validation_failed", "CDP port is outside the worker range", 400);
    const profileVolume = spec.volumes.find((volume) => volume.target === "/fabric/profile")?.source;
    const profilePath = profileVolume && this.#profileRoot ? join(this.#profileRoot, basename(profileVolume)) : profileVolume;
    if (profilePath && this.#profileRoot) mkdirSync(profilePath, { recursive: true });
    // A host-local browser has a host default route, unlike an internal Compose browser container.
    // Refuse to launch it until its loopback Fabric PAC is available and fail-closed; otherwise a
    // transient sidecar outage could make Chromium silently use direct host egress.
    const pacArgument = spec.command.find((argument) => argument.startsWith("--proxy-pac-url="));
    if (pacArgument) await this.#verifyEgressPac(pacArgument.slice("--proxy-pac-url=".length));
    const args = [
      ...spec.command.slice(1).filter((argument) => !argument.startsWith("--remote-debugging-port=") && !argument.startsWith("--user-data-dir=")),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profilePath ?? `/tmp/fabric-${crypto.randomUUID()}`}`,
      "--no-first-run",
      "--no-default-browser-check"
    ];
    // The browser receives only non-secret recipe/policy metadata, never client input values.
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: "C.UTF-8", ...spec.environment };
    this.#throwIfCancelled(processId);
    const child = this.#spawner.spawn(command, args, { cwd: this.#cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    this.#processes.set(processId, child);
    // A browser can terminate without the scheduler receiving a lease heartbeat first. Remove it
    // from the supervisor's liveness map immediately so the local agent's next reconciliation
    // tick fails the lease instead of continuing to heartbeat a dead process.
    child.once("exit", () => {
      this.#cancelled.add(processId);
      if (this.#processes.get(processId) === child) this.#processes.delete(processId);
      const guardian = this.#guardians.get(processId);
      this.#guardians.delete(processId);
      void guardian?.stop();
    });
    try {
      const version = await pollVersion(`http://127.0.0.1:${port}`, this.#startupTimeoutMs, this.#fetch, () => this.#cancelled.has(processId));
      this.#throwIfCancelled(processId);
      // Generated Fabric browser specs opt in to the process-level guardian.
      // Starting it after CDP readiness but before the assignment is marked
      // ready gives every page/tab the Media-style automatic Turnstile
      // handling, independent of which application owns the CDP connection.
      const guardianSpec = spec.turnstileGuardian ?? turnstileGuardianSpecFromEnvironment();
      assertTurnstileGuardianSpec(guardianSpec);
      {
        const tokenSolver = this.#tokenSolverFor?.(spec.challengeHandlers);
        const guardian = this.#guardianFactory({ endpoint: version.webSocketDebuggerUrl, spec: guardianSpec, ...(tokenSolver ? { tokenSolver } : {}) });
        // Register before awaiting startup so a browser exit or a concurrent
        // stop can always find and close the companion connection.
        this.#guardians.set(processId, guardian);
        this.#browserEndpoints.set(processId, version.webSocketDebuggerUrl);
        await guardian.start();
        this.#throwIfCancelled(processId);
        if (this.#processes.get(processId) !== child || this.#guardians.get(processId) !== guardian) {
          await guardian.stop().catch(() => undefined);
          throw new FabricError("worker_unavailable", "Chromium stopped while its Turnstile guardian was starting", 503);
        }
        if (!guardian.snapshot.running) throw new FabricError("worker_unavailable", "Turnstile guardian did not become ready", 503);
      }
      return { processId, cdpBrowserEndpoint: version.webSocketDebuggerUrl, ...(child.pid === undefined ? {} : { pid: child.pid }) };
    } catch (error) {
      await this.#stopStartedProcess(processId);
      throw error;
    }
  }

  public async stop(processId: string): Promise<void> {
    this.#cancelled.add(processId);
    await this.#stopStartedProcess(processId);
  }

  async #stopStartedProcess(processId: string): Promise<void> {
    const child = this.#processes.get(processId);
    const guardian = this.#guardians.get(processId);
    this.#guardians.delete(processId);
    await guardian?.stop().catch(() => undefined);
    const browserEndpoint = this.#browserEndpoints.get(processId);
    this.#browserEndpoints.delete(processId);
    if (!child) return;
    this.#processes.delete(processId);
    // Register before signaling: a minimal/local process implementation can
    // emit exit synchronously from kill, and must not leave us waiting for a
    // listener installed too late.
    const exited = waitForExit(child);
    // SIGTERM skips Chromium's cookie flush; close it through CDP first so the profile keeps logins.
    if (browserEndpoint && await this.#closeBrowser(browserEndpoint, { timeoutMs: 5_000 })) {
      await Promise.race([exited, Bun.sleep(5_000)]);
    }
    if (!child.kill("SIGTERM")) return;
    // Give Chromium a short graceful window, then terminate to avoid leaked profile locks.
    await Promise.race([exited, Bun.sleep(2_000)]);
    try { child.kill("SIGKILL"); } catch { /* process already exited */ }
  }

  public async stopAll(): Promise<void> {
    for (const processId of this.#starting.keys()) this.#cancelled.add(processId);
    await Promise.all([...this.#starting.values()].map((starting) => starting.catch(() => undefined)));
    await Promise.all([...this.#processes.keys()].map((id) => this.stop(id)));
  }

  public activeProcessIds(): readonly string[] { return [...this.#processes.keys()]; }

  public isRunning(processId: string): boolean {
    if (!this.#processes.has(processId)) return false;
    const guardian = this.#guardians.get(processId);
    return guardian?.snapshot.running ?? true;
  }

  /** Exposes only guardian health/counter telemetry—never page content or tokens. */
  public guardianSnapshot(processId: string): TurnstileGuardianSnapshot | undefined {
    const snapshot = this.#guardians.get(processId)?.snapshot;
    return snapshot ? { ...snapshot } : undefined;
  }

  #throwIfCancelled(processId: string): void {
    if (this.#cancelled.has(processId)) throw new FabricError("worker_unavailable", "Chromium startup was cancelled", 503);
  }

  async #verifyEgressPac(value: string): Promise<void> {
    let url: URL;
    try { url = new URL(value); } catch { throw new FabricError("validation_failed", "local browser egress PAC URL is invalid", 400); }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1") || url.username || url.password) {
      throw new FabricError("validation_failed", "local browser egress PAC must be a loopback HTTP(S) URL", 400);
    }
    let response: Response;
    try {
      response = await this.#fetch(url, { signal: AbortSignal.timeout(Math.min(5_000, this.#startupTimeoutMs)) });
    } catch {
      throw new FabricError("worker_unavailable", "local Fabric egress PAC is unavailable", 503);
    }
    const body = response.ok ? await response.text().catch(() => "") : "";
    if (!response.ok) throw new FabricError("worker_unavailable", "local Fabric egress PAC is unavailable", 503);
    assertFailClosedPac(body);
  }
}
