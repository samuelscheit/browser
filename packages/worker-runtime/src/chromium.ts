import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { BrowserContainerSpec } from "./index";
import { FabricError } from "@browser-fabric/contracts";

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

const defaultSpawner: ChromiumSpawner = { spawn: (command, args, options) => spawn(command, [...args], options) as unknown as ChromiumProcess };

function commandPath(spec: BrowserContainerSpec, configuredPath?: string): string {
  const command = spec.command[0];
  const expected = configuredPath ?? "/usr/bin/chromium";
  if (!command || command !== expected) throw new FabricError("validation_failed", "worker may launch only the pinned Chromium executable", 400);
  return expected;
}

async function pollVersion(endpoint: string, timeoutMs: number, fetcher: typeof fetch): Promise<{ webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
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
  readonly #spawner: ChromiumSpawner;
  readonly #fetch: typeof fetch;
  readonly #cwd: string;
  readonly #startupTimeoutMs: number;
  readonly #executablePath?: string;

  public constructor(options: { spawner?: ChromiumSpawner; fetch?: typeof fetch; cwd?: string; startupTimeoutMs?: number; executablePath?: string } = {}) {
    this.#spawner = options.spawner ?? defaultSpawner;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#cwd = options.cwd ?? "/tmp";
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
    this.#executablePath = options.executablePath;
  }

  public async start(spec: BrowserContainerSpec): Promise<ChromiumLaunchResult> {
    const command = commandPath(spec, this.#executablePath);
    const port = spec.cdpBind.port;
    if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new FabricError("validation_failed", "CDP port is outside the worker range", 400);
    const processId = `${spec.workerId}:${spec.leaseId ?? spec.jobId ?? crypto.randomUUID()}`;
    if (this.#processes.has(processId)) throw new FabricError("conflict", "a browser process already exists for this lease", 409);
    const profileVolume = spec.volumes.find((volume) => volume.target === "/fabric/profile")?.source;
    const args = [
      ...spec.command.slice(1).filter((argument) => !argument.startsWith("--remote-debugging-port=") && !argument.startsWith("--user-data-dir=")),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileVolume ?? `/tmp/fabric-${crypto.randomUUID()}`}`,
      "--no-first-run",
      "--no-default-browser-check"
    ];
    // The browser receives only non-secret recipe/policy metadata, never client input values.
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: "C.UTF-8", ...spec.environment };
    const child = this.#spawner.spawn(command, args, { cwd: this.#cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    this.#processes.set(processId, child);
    try {
      const version = await pollVersion(`http://127.0.0.1:${port}`, this.#startupTimeoutMs, this.#fetch);
      return { processId, cdpBrowserEndpoint: version.webSocketDebuggerUrl, ...(child.pid === undefined ? {} : { pid: child.pid }) };
    } catch (error) {
      await this.stop(processId);
      throw error;
    }
  }

  public async stop(processId: string): Promise<void> {
    const child = this.#processes.get(processId);
    if (!child) return;
    this.#processes.delete(processId);
    if (!child.kill("SIGTERM")) return;
    // Give Chromium a short graceful window, then terminate to avoid leaked profile locks.
    await Promise.race([once(child as unknown as ChildProcess, "exit"), Bun.sleep(2_000)]);
    try { child.kill("SIGKILL"); } catch { /* process already exited */ }
  }

  public async stopAll(): Promise<void> {
    await Promise.all([...this.#processes.keys()].map((id) => this.stop(id)));
  }

  public activeProcessIds(): readonly string[] { return [...this.#processes.keys()]; }
}
