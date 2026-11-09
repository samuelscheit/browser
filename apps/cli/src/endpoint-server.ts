import type { Server, ServerWebSocket } from "bun";
import { CdpConnection } from "@browser-fabric/worker-runtime";
import type { BrowserBackend, UpstreamEndpoint } from "./backend";

/** Chromium's DevTools ids are int32; a page-socket attach uses one no client reaches. */
const MUX_ATTACH_ID = 2_147_480_000;
const MAX_PENDING_MESSAGES = 512;
const MAX_MESSAGE_BYTES = 512 * 1024 * 1024;

type ClientKind = { kind: "browser" } | { kind: "page"; targetId: string };
type ClientData = ClientKind & {
  upstream?: WebSocket;
  /** Client frames that arrived before the upstream socket (and page attach) were ready. */
  pending: (string | Uint8Array)[];
  sessionId?: string;
  ready: boolean;
  closed: boolean;
};

export interface EndpointServerOptions {
  backend: BrowserBackend;
  port: number;
  host?: string;
  /** Close the browser anchor and suspend the backend after this long without a client. */
  idleMs: number;
  liveViewHtml: string;
  log?: (message: string) => void;
  onStateChange?: (state: "ready" | "idle") => void;
}

interface TargetInfo { targetId: string; type: string; title: string; url: string; attached?: boolean }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "no-store" } });
const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain; charset=UTF-8" } });

/** Close reasons are limited to 123 bytes by RFC 6455. */
export function closeReason(message: string): string {
  const encoded = new TextEncoder().encode(message);
  return encoded.length <= 120 ? message : `${new TextDecoder().decode(encoded.slice(0, 117)).replace(/�$/, "")}...`;
}

/**
 * A Chrome-compatible DevTools HTTP/WebSocket surface on loopback, backed by a remote Fabric
 * session or a local Chrome. Any CDP tool (Playwright, Puppeteer, chrome-devtools-mcp,
 * Playwright MCP, DevTools) can use `http://127.0.0.1:<port>` without knowing about Fabric.
 */
export class EndpointServer {
  readonly #options: EndpointServerOptions;
  readonly #clients = new Set<ServerWebSocket<ClientData>>();
  readonly #allowedHosts: Set<string>;
  #server?: Server<ClientData>;
  #anchor?: CdpConnection;
  #anchoring?: Promise<CdpConnection>;
  #idleTimer?: ReturnType<typeof setTimeout>;
  #suspended = false;
  /** Most-recent-use rank per target (created, navigated or activated), like Chrome's /json/list order. */
  readonly #recency = new Map<string, { rank: number; url: string }>();
  #rank = 0;

  public constructor(options: EndpointServerOptions) {
    this.#options = options;
    this.#allowedHosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`, `[::1]:${options.port}`]);
  }

  public get clientCount(): number { return this.#clients.size; }

  public listen(): void {
    this.#server = Bun.serve<ClientData>({
      hostname: this.#options.host ?? "127.0.0.1",
      port: this.#options.port,
      // A first request may wait for a remote browser to start.
      idleTimeout: 255,
      fetch: (request, server) => this.#fetch(request, server),
      websocket: {
        maxPayloadLength: MAX_MESSAGE_BYTES,
        backpressureLimit: MAX_MESSAGE_BYTES,
        perMessageDeflate: false,
        open: (socket) => this.#open(socket),
        message: (socket, message) => this.#message(socket, message),
        close: (socket) => this.#close(socket),
      },
    });
  }

  /** Start the browser now so the first client does not wait. */
  public async warm(): Promise<void> {
    await this.#ensureAnchor();
    this.#scheduleIdle();
  }

  public async stop(): Promise<void> {
    clearTimeout(this.#idleTimer);
    for (const client of this.#clients) client.close(1001, "fabric endpoint stopping");
    this.#anchor?.close();
    this.#anchor = undefined;
    await this.#server?.stop(true);
  }

  #hostAllowed(request: Request): boolean {
    const host = request.headers.get("host");
    return !host || this.#allowedHosts.has(host.toLowerCase());
  }

  /** Websites the user visits must not drive this browser (Chrome's --remote-allow-origins equivalent). */
  #originAllowed(request: Request): boolean {
    const origin = request.headers.get("origin");
    if (!origin) return true;
    if (origin === "devtools://devtools") return true;
    try {
      const url = new URL(origin);
      return url.protocol === "http:" && this.#allowedHosts.has(url.host);
    } catch {
      return false;
    }
  }

  #publicHost(request: Request): string {
    const host = request.headers.get("host");
    return host && this.#allowedHosts.has(host.toLowerCase()) ? host : `127.0.0.1:${this.#options.port}`;
  }

  async #fetch(request: Request, server: Server<ClientData>): Promise<Response | undefined> {
    if (!this.#hostAllowed(request)) return text("Host header is not a loopback address of this endpoint", 403);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (!this.#originAllowed(request)) return text("Origin is not allowed to use this browser", 403);
      const page = /^\/devtools\/page\/([A-Za-z0-9._-]{1,128})$/.exec(path);
      const kind: ClientKind | undefined = path.startsWith("/devtools/browser") ? { kind: "browser" } : page ? { kind: "page", targetId: page[1]! } : undefined;
      if (!kind) return text("not found", 404);
      return server.upgrade(request, { data: { ...kind, pending: [], ready: false, closed: false } }) ? undefined : text("websocket upgrade failed", 400);
    }

    if (path === "/") return new Response(this.#options.liveViewHtml, { headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "no-store" } });
    if (path === "/healthz") return json({ status: "ok", clients: this.#clients.size, suspended: this.#suspended, ...this.#options.backend.describe() });

    try {
      const host = this.#publicHost(request);
      if (path === "/json/version") {
        const version = await this.#command("Browser.getVersion");
        return json({
          Browser: version.product,
          "Protocol-Version": version.protocolVersion,
          "User-Agent": version.userAgent,
          "V8-Version": version.jsVersion,
          "WebKit-Version": version.revision,
          webSocketDebuggerUrl: `ws://${host}/devtools/browser/fabric`,
        });
      }
      if (path === "/json" || path === "/json/list") {
        const { targetInfos } = await this.#command("Target.getTargets") as { targetInfos: TargetInfo[] };
        return json(targetInfos
          .filter((target) => target.type !== "browser" && target.type !== "tab")
          .sort((left, right) => (this.#recency.get(right.targetId)?.rank ?? 0) - (this.#recency.get(left.targetId)?.rank ?? 0))
          .map((target) => targetEntry(target, host)));
      }
      if (path === "/json/new") {
        if (request.method !== "PUT" && request.method !== "GET") return text("use PUT /json/new?<url>", 405);
        const target = url.search.length > 1 ? decodeURIComponent(url.search.slice(1)) : "about:blank";
        const { targetId } = await this.#command("Target.createTarget", { url: target });
        const { targetInfo } = await this.#command("Target.getTargetInfo", { targetId }) as { targetInfo: TargetInfo };
        return json(targetEntry(targetInfo, host));
      }
      const action = /^\/json\/(close|activate)\/([A-Za-z0-9._-]{1,128})$/.exec(path);
      if (action) {
        await this.#command(action[1] === "close" ? "Target.closeTarget" : "Target.activateTarget", { targetId: action[2] });
        if (action[1] === "activate") this.#touchTarget(action[2]!);
        return text(action[1] === "close" ? "Target is closing" : "Target activated");
      }
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), 502);
    }
    return text("not found", 404);
  }

  async #command(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const anchor = await this.#ensureAnchor();
    try {
      return await anchor.send(method, params);
    } finally {
      this.#scheduleIdle();
    }
  }

  /**
   * One long-lived connection keeps the browser alive between short-lived clients (Fabric
   * releases a session 60 s after its last CDP client leaves) and answers /json queries.
   */
  async #ensureAnchor(): Promise<CdpConnection> {
    clearTimeout(this.#idleTimer);
    if (this.#anchor && !this.#anchor.closed) return this.#anchor;
    this.#anchoring ??= (async () => {
      const upstream = await this.#options.backend.acquire();
      const anchor = await CdpConnection.connect({ endpoint: upstream.url, ...(upstream.headers ? { headers: upstream.headers } : {}), timeoutMs: 30_000 });
      this.#recency.clear();
      anchor.onMessage((message) => this.#trackTarget(message));
      await anchor.send("Target.setDiscoverTargets", { discover: true });
      anchor.onClose(() => {
        if (this.#anchor !== anchor) return;
        this.#anchor = undefined;
        this.#options.log?.("browser connection closed; the next client reconnects");
      });
      this.#anchor = anchor;
      if (this.#suspended) this.#options.log?.("browser resumed");
      this.#suspended = false;
      this.#options.onStateChange?.("ready");
      return anchor;
    })().finally(() => { this.#anchoring = undefined; });
    return this.#anchoring;
  }

  #touchTarget(targetId: string, url?: string): void {
    this.#recency.set(targetId, { rank: ++this.#rank, url: url ?? this.#recency.get(targetId)?.url ?? "" });
  }

  #trackTarget(message: Record<string, any>): void {
    const info = message.params?.targetInfo as TargetInfo | undefined;
    if (message.method === "Target.targetCreated" && info) this.#touchTarget(info.targetId, info.url);
    else if (message.method === "Target.targetInfoChanged" && info && this.#recency.get(info.targetId)?.url !== info.url) this.#touchTarget(info.targetId, info.url);
    else if (message.method === "Target.targetDestroyed") this.#recency.delete(message.params.targetId);
  }

  #scheduleIdle(): void {
    clearTimeout(this.#idleTimer);
    if (this.#clients.size > 0 || this.#suspended) return;
    this.#idleTimer = setTimeout(() => void this.#suspend(), this.#options.idleMs);
  }

  async #suspend(): Promise<void> {
    if (this.#clients.size > 0 || this.#anchoring) return;
    this.#suspended = true;
    const anchor = this.#anchor;
    this.#anchor = undefined;
    anchor?.close();
    await this.#options.backend.suspend();
    this.#options.log?.(`no client for ${Math.round(this.#options.idleMs / 60_000)} min; browser suspended`);
    this.#options.onStateChange?.("idle");
  }

  #open(socket: ServerWebSocket<ClientData>): void {
    this.#clients.add(socket);
    clearTimeout(this.#idleTimer);
    void this.#connectUpstream(socket).catch((error) => {
      this.#options.log?.(`client connection failed: ${error instanceof Error ? error.message : String(error)}`);
      socket.close(1011, closeReason(error instanceof Error ? error.message : String(error)));
    });
  }

  async #connectUpstream(socket: ServerWebSocket<ClientData>): Promise<void> {
    await this.#ensureAnchor();
    const endpoint: UpstreamEndpoint = await this.#options.backend.acquire();
    if (socket.data.closed) return;
    const upstream = new WebSocket(endpoint.url, endpoint.headers ? { headers: endpoint.headers } as never : undefined);
    upstream.binaryType = "arraybuffer";
    socket.data.upstream = upstream;
    upstream.addEventListener("open", () => {
      if (socket.data.kind === "page") {
        upstream.send(JSON.stringify({ id: MUX_ATTACH_ID, method: "Target.attachToTarget", params: { targetId: socket.data.targetId, flatten: true } }));
        return;
      }
      this.#markReady(socket);
    });
    upstream.addEventListener("message", (event) => {
      if (socket.data.closed) return;
      if (socket.data.kind === "browser") {
        socket.send(event.data as string | ArrayBuffer);
        return;
      }
      const message = parseJson(event.data);
      if (!message) return;
      if (!socket.data.sessionId) {
        if (message.id !== MUX_ATTACH_ID) return;
        if (message.error || typeof message.result?.sessionId !== "string") {
          socket.close(1011, closeReason(`No such target ${socket.data.targetId}`));
          return;
        }
        socket.data.sessionId = message.result.sessionId;
        this.#markReady(socket);
        return;
      }
      if (message.sessionId === socket.data.sessionId) {
        delete message.sessionId;
        socket.send(JSON.stringify(message));
      } else if (message.method === "Target.detachedFromTarget" && message.params?.sessionId === socket.data.sessionId) {
        socket.close(1000, "target closed");
      }
    });
    upstream.addEventListener("close", (event) => {
      if (!socket.data.closed) socket.close(1000, closeReason(event.reason || "browser connection closed"));
    });
    upstream.addEventListener("error", () => {
      if (!socket.data.closed) socket.close(1011, "browser connection failed");
    });
  }

  #markReady(socket: ServerWebSocket<ClientData>): void {
    socket.data.ready = true;
    for (const message of socket.data.pending.splice(0)) this.#forward(socket, message);
  }

  #forward(socket: ServerWebSocket<ClientData>, message: string | Uint8Array): void {
    const upstream = socket.data.upstream;
    if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
    if (socket.data.kind === "browser") {
      upstream.send(message);
      return;
    }
    const parsed = parseJson(message);
    if (!parsed) return;
    parsed.sessionId = socket.data.sessionId;
    upstream.send(JSON.stringify(parsed));
  }

  #message(socket: ServerWebSocket<ClientData>, message: string | Buffer): void {
    if (socket.data.ready) {
      this.#forward(socket, message);
      return;
    }
    if (socket.data.pending.length >= MAX_PENDING_MESSAGES) {
      socket.close(1013, "browser is still starting; too many queued messages");
      return;
    }
    socket.data.pending.push(message);
  }

  #close(socket: ServerWebSocket<ClientData>): void {
    socket.data.closed = true;
    this.#clients.delete(socket);
    try { socket.data.upstream?.close(); } catch { /* already closed */ }
    this.#scheduleIdle();
  }
}

function parseJson(data: unknown): Record<string, any> | undefined {
  try {
    const raw = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer | Uint8Array);
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function targetEntry(target: TargetInfo, host: string) {
  return {
    description: "",
    devtoolsFrontendUrl: `devtools://devtools/bundled/inspector.html?ws=${host}/devtools/page/${target.targetId}`,
    id: target.targetId,
    title: target.title,
    type: target.type,
    url: target.url,
    webSocketDebuggerUrl: `ws://${host}/devtools/page/${target.targetId}`,
  };
}
