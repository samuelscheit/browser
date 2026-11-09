/**
 * A small dependency-free CDP client shared by Fabric-owned browser companions
 * (the Turnstile guardian), the agent CLI and its live view.
 */

export const DEFAULT_CDP_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 15_000;

/** Minimal fetch surface required for deterministic CDP discovery tests. */
export type CdpFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Small WebSocket surface shared by native and deterministic test transports. */
export interface CdpTransport {
  readonly readyState?: number;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void, options?: { once?: boolean }): void;
  removeEventListener?(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
}

export type CdpTransportFactory = (webSocketUrl: string, timeoutMs: number) => Promise<CdpTransport>;

export function parseCdpMessage(event: any): Record<string, any> | undefined {
  const raw = typeof event?.data === "string"
    ? event.data
    : event?.data instanceof ArrayBuffer
      ? new TextDecoder().decode(event.data)
      : undefined;
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value as Record<string, any> : undefined;
  } catch {
    return undefined;
  }
}

/** Chromium's own browser target, or a Fabric gateway session (which is always browser-level). */
function isBrowserLevelWebSocketPath(pathname: string): boolean {
  return pathname.startsWith("/devtools/browser/") || /^\/v1\/cdp\/browser-session_[A-Za-z0-9_-]+$/.test(pathname);
}

/**
 * Resolve a browser's HTTP `/json/version` endpoint into its browser-level CDP
 * websocket. Chromium advertises its own loopback authority, so the opaque
 * DevTools path is kept while the authority the caller can reach is retained.
 */
export async function resolveBrowserWebSocketEndpoint(
  endpoint: string,
  options: { fetcher?: CdpFetcher; timeoutMs?: number } = {},
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("CDP endpoint is not a valid URL");
  }
  if (parsed.username || parsed.password) throw new Error("CDP endpoint must not contain credentials");
  if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
    if (!isBrowserLevelWebSocketPath(parsed.pathname)) throw new Error("CDP endpoint must be a browser-level websocket");
    return parsed.toString();
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("CDP endpoint must be HTTP(S) or WebSocket");
  if (parsed.hash) throw new Error("CDP HTTP endpoint must not contain a fragment");
  const versionUrl = parsed.pathname.endsWith("/json/version") ? parsed : new URL("/json/version", parsed);
  const response = await (options.fetcher ?? globalThis.fetch)(versionUrl, {
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_CDP_CONNECT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Chromium /json/version returned HTTP ${response.status}`);
  const body = await response.json() as { webSocketDebuggerUrl?: unknown };
  if (typeof body.webSocketDebuggerUrl !== "string" || body.webSocketDebuggerUrl.length > 4_096 || !/^wss?:\/\//.test(body.webSocketDebuggerUrl)) {
    throw new Error("Chromium did not return a websocket debugger endpoint");
  }
  const discovered = new URL(body.webSocketDebuggerUrl);
  if (discovered.username || discovered.password) throw new Error("Chromium returned a websocket debugger endpoint containing credentials");
  if (!discovered.pathname.startsWith("/devtools/browser/")) throw new Error("Chromium returned a non-browser websocket debugger endpoint");
  discovered.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  discovered.host = parsed.host;
  return discovered.toString();
}

class NativeCdpTransport implements CdpTransport {
  readonly #socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
  }

  public static async connect(url: string, timeoutMs: number, headers?: Readonly<Record<string, string>>): Promise<NativeCdpTransport> {
    // Bun's WebSocket accepts upgrade headers, which authenticated Fabric gateways require.
    const socket = headers ? new WebSocket(url, { headers } as never) : new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        if (error) {
          try { socket.close(); } catch { /* the socket may not have opened */ }
        }
        if (error) reject(error); else resolve();
      };
      const onOpen = () => finish();
      const onError = () => finish(new Error("CDP websocket failed to connect"));
      const timer = setTimeout(() => finish(new Error("CDP websocket connection timed out")), timeoutMs);
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });
    return new NativeCdpTransport(socket);
  }

  get readyState(): number { return this.#socket.readyState; }
  send(message: string): void { this.#socket.send(message); }
  close(code?: number, reason?: string): void { try { this.#socket.close(code, reason); } catch { /* already closed */ } }
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void, options?: { once?: boolean }): void { this.#socket.addEventListener(type, listener, options); }
  removeEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void { this.#socket.removeEventListener(type, listener); }
}

type PendingCommand = { method: string; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

export class CdpConnection {
  readonly #transport: CdpTransport;
  readonly #pending = new Map<number, PendingCommand>();
  readonly #listeners = new Set<(message: Record<string, any>) => void>();
  readonly #closeListeners = new Set<() => void>();
  #nextId = 1;
  #closed = false;

  private constructor(transport: CdpTransport) {
    this.#transport = transport;
    transport.addEventListener("message", (event) => {
      const message = parseCdpMessage(event);
      if (!message) return;
      const id = typeof message.id === "number" ? message.id : undefined;
      if (id !== undefined) {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`${pending.method}: ${typeof message.error.message === "string" ? message.error.message : "CDP command failed"}`));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.#listeners) listener(message);
    });
    const close = () => this.#notifyClosed();
    transport.addEventListener("close", close, { once: true });
    transport.addEventListener("error", close, { once: true });
  }

  /** Connect to a browser-level websocket, or discover it through an HTTP(S) `/json/version` endpoint. */
  public static async connect(options: {
    endpoint: string;
    timeoutMs?: number;
    transportFactory?: CdpTransportFactory;
    fetcher?: CdpFetcher;
    /** Upgrade headers for an authenticated browser-level websocket (for example Basic auth at the Fabric edge). */
    headers?: Readonly<Record<string, string>>;
  }): Promise<CdpConnection> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CDP_CONNECT_TIMEOUT_MS;
    const url = await resolveBrowserWebSocketEndpoint(options.endpoint, { fetcher: options.fetcher, timeoutMs });
    const transport = options.transportFactory
      ? await options.transportFactory(url, timeoutMs)
      : await NativeCdpTransport.connect(url, timeoutMs, options.headers);
    return new CdpConnection(transport);
  }

  public get closed(): boolean { return this.#closed; }

  public onMessage(listener: (message: Record<string, any>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  public async send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = DEFAULT_CDP_COMMAND_TIMEOUT_MS): Promise<any> {
    if (this.#closed || this.#transport.readyState !== undefined && this.#transport.readyState === 3) throw new Error("CDP connection is closed");
    const id = this.#nextId++;
    const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP command ${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        this.#transport.send(payload);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public close(): void {
    if (this.#closed) return;
    this.#notifyClosed();
    this.#transport.close(1000, "CDP client closed");
  }

  #failPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }

  #notifyClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failPending(new Error("CDP connection closed"));
    for (const listener of this.#closeListeners) listener();
    this.#closeListeners.clear();
  }
}

/**
 * Close Chromium the orderly way before its process or container is stopped. On SIGTERM Chromium
 * takes its "session ending" fast path, which skips flushing the cookie store (written lazily,
 * about every 30 s), so a login made just before release would vanish from a persistent profile.
 * `Browser.close` runs the normal shutdown and writes everything to the profile. Returns whether
 * the browser closed within `timeoutMs`; callers still signal/stop afterwards as a fallback.
 */
export async function closeBrowserGracefully(endpoint: string, options: { timeoutMs?: number; headers?: Readonly<Record<string, string>>; transportFactory?: CdpTransportFactory; fetcher?: CdpFetcher } = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let connection: CdpConnection;
  try {
    connection = await CdpConnection.connect({
      endpoint,
      timeoutMs: Math.min(timeoutMs, DEFAULT_CDP_CONNECT_TIMEOUT_MS),
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.transportFactory ? { transportFactory: options.transportFactory } : {}),
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
  } catch {
    return false;
  }
  const disconnected = new Promise<boolean>((resolve) => {
    if (connection.closed) resolve(true);
    connection.onClose(() => resolve(true));
    setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
  });
  // Chromium usually drops the socket before it answers; the disconnect is the signal that matters.
  connection.send("Browser.close", {}, undefined, Math.max(1, deadline - Date.now())).catch(() => undefined);
  const closed = await disconnected;
  connection.close();
  return closed;
}
