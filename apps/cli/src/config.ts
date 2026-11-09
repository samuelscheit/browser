import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type BrowserMode = "remote" | "local";

/** Where the CLI keeps credentials, daemon state, logs and local profiles. */
export function fabricHome(environment: Record<string, string | undefined> = process.env): string {
  return environment.FABRIC_HOME ?? join(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "fabric");
}

export interface Credentials {
  /** Fabric API base, e.g. https://browser.example/v1 */
  url: string;
  /** Opaque principal ID; Fabric usernames always start with `principal_`. */
  username: string;
  password: string;
}

const credentialsPath = (home: string) => join(home, "credentials.json");

export function normalizeApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Fabric URL ${JSON.stringify(raw)} is not a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Fabric URL must be http(s)");
  if (url.username || url.password) throw new Error("Fabric URL must not contain credentials; use `fabric login`");
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function normalizeUsername(raw: string): string {
  const username = raw.trim();
  return username.startsWith("principal_") ? username : `principal_${username}`;
}

/** Environment variables win over the stored file so CI and one-off runs need no login. */
export function loadCredentials(home = fabricHome(), environment: Record<string, string | undefined> = process.env): Credentials {
  const stored = existsSync(credentialsPath(home))
    ? JSON.parse(readFileSync(credentialsPath(home), "utf8")) as Partial<Credentials>
    : {};
  const url = environment.FABRIC_URL ?? stored.url;
  const username = environment.FABRIC_USERNAME ?? stored.username;
  const password = environment.FABRIC_PASSWORD ?? stored.password;
  if (!url || !username || !password) {
    throw new Error("No Fabric credentials. Run `fabric login --url <https://host> --username <principal> < password-file` or set FABRIC_URL, FABRIC_USERNAME and FABRIC_PASSWORD.");
  }
  return { url: normalizeApiUrl(url), username: normalizeUsername(username), password };
}

export function saveCredentials(credentials: Credentials, home = fabricHome()): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = credentialsPath(home);
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function basicAuthorization(credentials: Pick<Credentials, "username" | "password">): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString("base64")}`;
}

/** What `fabric up` asked for. The daemon receives it verbatim. */
export interface BrowserRequest {
  name: string;
  mode: BrowserMode;
  port: number;
  /** Remote: profile ref (default: the project's interactive profile). Local: profile directory name (default "agent"). */
  profile?: string;
  /** Remote only: a throwaway browser without a persistent profile. */
  fresh: boolean;
  project?: string;
  recipe?: string;
  egress?: string;
  ttlSeconds: number;
  idleMinutes: number;
  headless: boolean;
  chrome?: string;
}

/** What a running daemon publishes about itself. */
export interface DaemonState {
  request: BrowserRequest;
  pid: number;
  startedAt: string;
  status: "starting" | "ready" | "idle" | "failed";
  /** Remote session currently backing the endpoint, if any. */
  sessionId?: string;
  browser?: string;
  error?: string;
  updatedAt: string;
}

/** Local Chrome is the default browser, so it gets Chrome's conventional DevTools port. */
export const DEFAULT_PORTS: Record<BrowserMode, number> = { local: 9222, remote: 9223 };

export const runDirectory = (home = fabricHome()) => join(home, "run");
export const statePath = (name: string, home = fabricHome()) => join(runDirectory(home), `${name}.json`);
export const logPath = (name: string, home = fabricHome()) => join(runDirectory(home), `${name}.log`);
export const localProfileDirectory = (profile: string, home = fabricHome()) => join(home, "profiles", profile);

export function assertName(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error(`browser name ${JSON.stringify(name)} must be lowercase letters, digits and dashes`);
  return name;
}

export function writeState(state: DaemonState, home = fabricHome()): void {
  mkdirSync(runDirectory(home), { recursive: true, mode: 0o700 });
  writeFileSync(statePath(state.request.name, home), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function readState(name: string, home = fabricHome()): DaemonState | undefined {
  try {
    return JSON.parse(readFileSync(statePath(name, home), "utf8")) as DaemonState;
  } catch {
    return undefined;
  }
}

export function removeState(name: string, home = fabricHome()): void {
  rmSync(statePath(name, home), { force: true });
}

export function listStates(home = fabricHome()): DaemonState[] {
  if (!existsSync(runDirectory(home))) return [];
  return readdirSync(runDirectory(home))
    .filter((file) => file.endsWith(".json"))
    .map((file) => readState(file.slice(0, -5), home))
    .filter((state): state is DaemonState => state !== undefined);
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
