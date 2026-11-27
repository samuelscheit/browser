import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import {
  DEFAULT_PORTS,
  listStates,
  logPath,
  processAlive,
  readState,
  removeState,
  runDirectory,
  type BrowserRequest,
  type DaemonState,
} from "./config";

const CLI_ENTRY = new URL("./cli.ts", import.meta.url).pathname;

export const endpointUrl = (port: number) => `http://127.0.0.1:${port}`;

export function liveState(name: string): DaemonState | undefined {
  const state = readState(name);
  if (!state) return undefined;
  if (processAlive(state.pid)) return state;
  // Keep a failed daemon's state so `up` can explain why; drop a vanished one.
  if (state.status !== "failed") removeState(name);
  return undefined;
}

export function liveStates(): DaemonState[] {
  return listStates()
    .map((state) => liveState(state.request.name))
    .filter((state): state is DaemonState => state !== undefined);
}

function sameRequest(left: BrowserRequest, right: BrowserRequest): boolean {
  return left.mode === right.mode && left.port === right.port && left.fresh === right.fresh
    && (left.profile ?? "") === (right.profile ?? "") && (left.project ?? "") === (right.project ?? "")
    && (left.recipe ?? "") === (right.recipe ?? "") && (left.egress ?? "") === (right.egress ?? "")
    && left.headless === right.headless && (left.chrome ?? "") === (right.chrome ?? "");
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePromise(true)));
  });
}

/** A mode's default browser gets its well-known port; a running browser keeps its port; extra names take the next free one. */
export async function choosePort(name: string, mode: BrowserRequest["mode"], requested?: number): Promise<number> {
  if (requested !== undefined) return requested;
  const existing = liveState(name);
  if (existing) return existing.request.port;
  if (name === mode) return DEFAULT_PORTS[mode];
  const taken = new Set(liveStates().map((state) => state.request.port));
  for (let port = 9224; port < 9300; port += 1) if (!taken.has(port) && await portFree(port)) return port;
  throw new Error("no free port between 9224 and 9299; pass --port");
}

function tail(path: string, lines = 15): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

/**
 * Idempotent: an agent can call `fabric up` before every task. A running browser with the same
 * settings is reused (and shared by every client), so parallel agents never fight over a profile.
 */
/**
 * `warm` (the default) returns once a browser is running; without it the endpoint is enough and
 * the browser starts on its first client, so an unused MCP server costs no browser.
 */
export async function up(request: BrowserRequest, options: { timeoutMs?: number; warm?: boolean; onNotice?: (notice: string) => void } = {}): Promise<DaemonState> {
  const warm = options.warm ?? true;
  const running = liveState(request.name);
  if (running) {
    if (!sameRequest(running.request, request)) {
      throw new Error(`browser "${request.name}" is already running with other settings (${JSON.stringify(running.request)}). Run \`fabric down ${request.name}\` first, or use --name.`);
    }
    if (running.status === "ready" || (running.status === "idle" && !warm)) return running;
    // Any /json request makes the endpoint start (or resume) its browser.
    if (running.status === "idle") await fetch(`${endpointUrl(running.request.port)}/json/version`).catch(() => undefined);
  } else {
    if (request.mode === "local" && request.profile) {
      const inUse = liveStates().find((state) =>
        state.request.name !== request.name
        && state.request.mode === "local"
        && state.request.profile === request.profile
        && state.status !== "failed",
      );
      if (inUse) {
        throw new Error(`profile "${request.profile}" is already in use by browser "${inUse.request.name}" (${endpointUrl(inUse.request.port)}). Reuse it with \`--name ${inUse.request.name}\`, or run \`fabric down ${inUse.request.name}\` first.`);
      }
    }
    removeState(request.name);
    mkdirSync(runDirectory(), { recursive: true, mode: 0o700 });
    const log = openSync(logPath(request.name), "a", 0o600);
    const child = spawn(process.execPath, [CLI_ENTRY, "__daemon", JSON.stringify(request), warm ? "warm" : "lazy"], { detached: true, stdio: ["ignore", log, log], env: process.env });
    child.unref();
    closeSync(log);
  }
  // The daemon owns the real deadlines (a browser start, the user enabling remote debugging and
  // clicking Allow); this one only guards against a daemon that hangs.
  const timeoutMs = options.timeoutMs ?? 600_000;
  const deadline = Date.now() + timeoutMs;
  const onNotice = options.onNotice ?? ((notice: string) => console.error(`fabric: ${notice}`));
  let shown: string | undefined;
  while (Date.now() < deadline) {
    const state = readState(request.name);
    if (state?.notice && state.notice !== shown) onNotice(state.notice);
    shown = state?.notice;
    if (state?.status === "failed") {
      throw new Error(`${state.error ?? "browser failed to start"}\n--- ${logPath(request.name)} ---\n${tail(logPath(request.name))}`);
    }
    if (state && (state.status === "ready" || (state.status === "idle" && !warm)) && processAlive(state.pid)) return state;
    if (state && !processAlive(state.pid)) throw new Error(`browser daemon exited during startup\n--- ${logPath(request.name)} ---\n${tail(logPath(request.name))}`);
    await Bun.sleep(150);
  }
  throw new Error(`browser "${request.name}" did not start within ${Math.round(timeoutMs / 1000)} s; see ${logPath(request.name)}`);
}

export async function down(name: string): Promise<boolean> {
  const state = readState(name);
  if (!state) return false;
  if (processAlive(state.pid)) {
    process.kill(state.pid, "SIGTERM");
    const deadline = Date.now() + 15_000;
    while (processAlive(state.pid) && Date.now() < deadline) await Bun.sleep(100);
    if (processAlive(state.pid)) process.kill(state.pid, "SIGKILL");
  }
  removeState(name);
  return true;
}

export function describeState(state: DaemonState): string {
  const url = endpointUrl(state.request.port);
  const what = state.request.mode === "remote"
    ? `remote browser${state.sessionId ? ` (session ${state.sessionId})` : ""}`
    : state.request.profile
      ? `Chrome fabric starts (profile ${state.request.profile}${state.request.headless ? ", headless" : ""})`
      : "your own Chrome (everyday profile, via chrome://inspect/#remote-debugging; down only detaches)";
  return [
    `${state.request.name}: ${what} — ${state.status}`,
    ...(state.notice ? [`  Action needed ${state.notice}`] : []),
    `  CDP endpoint  ${url}`,
    `  Live view     ${url}/`,
    `  Playwright    chromium.connectOverCDP("${url}")`,
    `  Log           ${logPath(state.request.name)}`,
  ].join("\n");
}

export const MCP_SERVERS = {
  playwright: (url: string) => ["-y", "@playwright/mcp@0.0.83", "--cdp-endpoint", url],
  devtools: (url: string) => ["-y", "chrome-devtools-mcp@1.12.0", "--browserUrl", url],
} as const;

/** stdio MCP server: make sure the browser runs, then hand stdin/stdout to the MCP package. */
export async function mcp(request: BrowserRequest, server: keyof typeof MCP_SERVERS, extra: readonly string[]): Promise<never> {
  const state = await up(request, { warm: false });
  const child = spawn("npx", [...MCP_SERVERS[server](endpointUrl(state.request.port)), ...extra], { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  const code = await new Promise<number>((resolvePromise) => child.once("exit", (exitCode, signal) => resolvePromise(exitCode ?? (signal ? 1 : 0))));
  process.exit(code);
}
