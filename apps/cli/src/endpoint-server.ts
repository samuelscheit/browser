import type { Server, ServerWebSocket } from "bun";
import { TurnstileGuardian, type CdpConnection } from "@browser-fabric/worker-runtime";
import type { BrowserBackend } from "./backend";
import { CdpMultiplexer, type ClientKind, type MuxClient, type TargetInfo } from "./cdp-mux";

const MAX_PENDING_MESSAGES = 512;
const MAX_MESSAGE_BYTES = 512 * 1024 * 1024;

type ClientData = {
  kind: ClientKind;
  client?: MuxClient;
  /** Client frames that arrived before the browser connection (and page attach) were ready. */
  pending: (string | Uint8Array)[];
  closed: boolean;
};

/** The companion that clicks Turnstile checkboxes, attached through the shared connection. */
export interface Guardian { start(): Promise<void>; stop(): Promise<void> }
export type GuardianFactory = (mux: CdpMultiplexer, agentTabsOnly: boolean, log: (message: string) => void) => Guardian;

export const turnstileGuardian: GuardianFactory = (mux, agentTabsOnly, log) => new TurnstileGuardian({
  // Never dialled: the transport is an in-process client of the multiplexer.
  endpoint: "ws://127.0.0.1/devtools/browser/fabric-guardian",
  transportFactory: async () => mux.transport({ agentTabsOnly }),
  logger: (event) => log(`turnstile ${event}`),
});

export interface EndpointServerOptions {
  backend: BrowserBackend;
  port: number;
  host?: string;
  /** With a backend that can suspend: release the browser after this long without a client. */
  idleMs: number;
  liveViewHtml: string;
  guardian?: GuardianFactory;
  log?: (message: string) => void;
  onStateChange?: (state: "ready" | "idle") => void;
}

interface Anchor { connection: CdpConnection; mux: CdpMultiplexer; guardian?: Guardian }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "no-store" } });
const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain; charset=UTF-8" } });

/** Close reasons are limited to 123 bytes by RFC 6455. */
export function closeReason(message: string): string {
  const encoded = new TextEncoder().encode(message);
  return encoded.length <= 120 ? message : `${new TextDecoder().decode(encoded.slice(0, 117)).replace(/�$/, "")}...`;
}

/**
 * A Chrome-compatible DevTools HTTP/WebSocket surface on loopback, backed by the user's Chrome, a
 * Chrome fabric launched, or a remote Fabric session. Any CDP tool (Playwright, Puppeteer,
 * chrome-devtools-mcp, Playwright MCP, DevTools) can use `http://127.0.0.1:<port>`. Every client
 * shares ONE upstream browser connection (see CdpMultiplexer), which Chrome's remote-debugging
 * toggle requires: each upstream WebSocket costs the user an "Allow" click.
 */
export class EndpointServer {
  readonly #options: EndpointServerOptions;
  readonly #clients = new Set<ServerWebSocket<ClientData>>();
  readonly #allowedHosts: Set<string>;
  #server?: Server<ClientData>;
  #anchor?: Anchor;
  #anchoring?: Promise<Anchor>;
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
  /** The multiplexer while the browser is connected (tests and diagnostics). */
  public get mux(): CdpMultiplexer | undefined { return this.#anchor?.mux; }

  public listen(): void {
    this.#server = Bun.serve<ClientData>({
      hostname: this.#options.host ?? "127.0.0.1",
      port: this.#options.port,
      // A first request may wait for a browser to start, or for the user to allow remote debugging.
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

  /** Connect the browser now so the first client does not wait. */
  public async warm(): Promise<void> {
    await this.#ensureAnchor();
    this.#scheduleIdle();
  }

  public async stop(): Promise<void> {
    clearTimeout(this.#idleTimer);
    for (const client of this.#clients) client.close(1001, "fabric endpoint stopping");
    await this.#dropAnchor("fabric endpoint stopping");
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
      return server.upgrade(request, { data: { kind, pending: [], closed: false } }) ? undefined : text("websocket upgrade failed", 400);
    }

    if (path === "/") return new Response(this.#options.liveViewHtml, { headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "no-store" } });
    if (path === "/healthz") {
      return json({ status: "ok", clients: this.#clients.size, connected: this.#anchor !== undefined, suspended: this.#suspended, ...this.#options.backend.describe() });
    }

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
        const mux = this.#anchor?.mux;
        return json(targetInfos
          .filter((target) => target.type !== "browser" && target.type !== "tab")
          .sort((left, right) => (this.#recency.get(right.targetId)?.rank ?? 0) - (this.#recency.get(left.targetId)?.rank ?? 0))
          .map((target) => ({ ...targetEntry(target, host), agentTab: mux?.isAgentTarget(target.targetId) ?? false })));
      }
      if (path === "/json/new") {
        if (request.method !== "PUT" && request.method !== "GET") return text("use PUT /json/new?<url>", 405);
        const target = url.search.length > 1 ? decodeURIComponent(url.search.slice(1)) : "about:blank";
        const { targetId } = await this.#command("Target.createTarget", { url: target });
        this.#anchor?.mux.adopt(targetId);
        const { targetInfo } = await this.#command("Target.getTargetInfo", { targetId }) as { targetInfo: TargetInfo };
        return json({ ...targetEntry(targetInfo, host), agentTab: true });
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
    const { connection } = await this.#ensureAnchor();
    try {
      return await connection.send(method, params);
    } finally {
      this.#scheduleIdle();
    }
  }

  /**
   * The one browser connection. It answers /json queries, carries every client, keeps a remote
   * session alive between short-lived clients, and is opened again only when a client needs it
   * after the browser went away (one new "Allow" click for the user's Chrome, never a retry loop).
   */
  async #ensureAnchor(): Promise<Anchor> {
    clearTimeout(this.#idleTimer);
    if (this.#anchor) return this.#anchor;
    this.#anchoring ??= (async () => {
      const connection = await this.#options.backend.connect();
      try {
        const mux = new CdpMultiplexer(connection, { ...(this.#options.log ? { log: this.#options.log } : {}) });
        this.#recency.clear();
        connection.onMessage((message) => this.#trackTarget(message));
        await mux.start();
        const anchor: Anchor = { connection, mux };
        connection.onClose(() => {
          if (this.#anchor !== anchor) return;
          this.#anchor = undefined;
          void anchor.guardian?.stop().catch(() => undefined);
          this.#options.log?.("browser connection closed; the next client reconnects");
        });
        this.#anchor = anchor;
        const scope = this.#options.backend.guardian;
        if (scope) {
          const log = this.#options.log ?? (() => undefined);
          const guardian = (this.#options.guardian ?? turnstileGuardian)(mux, scope === "agent-tabs", log);
          anchor.guardian = guardian;
          await guardian.start().catch((error) => log(`turnstile guardian unavailable: ${error instanceof Error ? error.message : String(error)}`));
        }
        if (this.#suspended) this.#options.log?.("browser resumed");
        this.#suspended = false;
        this.#options.onStateChange?.("ready");
        return anchor;
      } catch (error) {
        connection.close();
        throw error;
      }
    })().finally(() => { this.#anchoring = undefined; });
    return this.#anchoring;
  }

  async #dropAnchor(reason: string): Promise<void> {
    const anchor = this.#anchor;
    this.#anchor = undefined;
    if (!anchor) return;
    await anchor.guardian?.stop().catch(() => undefined);
    anchor.mux.close(reason);
    anchor.connection.close();
  }

  #touchTarget(targetId: string, url?: string): void {
    this.#recency.set(targetId, { rank: ++this.#rank, url: url ?? this.#recency.get(targetId)?.url ?? "" });
  }

  #trackTarget(message: Record<string, any>): void {
    if (message.sessionId) return;
    const info = message.params?.targetInfo as TargetInfo | undefined;
    if (message.method === "Target.targetCreated" && info) this.#touchTarget(info.targetId, info.url);
    else if (message.method === "Target.targetInfoChanged" && info && this.#recency.get(info.targetId)?.url !== info.url) this.#touchTarget(info.targetId, info.url);
    else if (message.method === "Target.targetDestroyed") this.#recency.delete(message.params.targetId);
  }

  #scheduleIdle(): void {
    clearTimeout(this.#idleTimer);
    if (!this.#options.backend.suspend || this.#clients.size > 0 || this.#suspended) return;
    this.#idleTimer = setTimeout(() => void this.#suspend(), this.#options.idleMs);
  }

  async #suspend(): Promise<void> {
    if (this.#clients.size > 0 || this.#anchoring) return;
    this.#suspended = true;
    await this.#dropAnchor("browser suspended");
    await this.#options.backend.suspend?.();
    this.#options.log?.(`no client for ${Math.round(this.#options.idleMs / 60_000)} min; browser suspended`);
    this.#options.onStateChange?.("idle");
  }

  #open(socket: ServerWebSocket<ClientData>): void {
    this.#clients.add(socket);
    clearTimeout(this.#idleTimer);
    void this.#attach(socket).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.#options.log?.(`client connection failed: ${message}`);
      if (!socket.data.closed) socket.close(1011, closeReason(message));
    });
  }

  async #attach(socket: ServerWebSocket<ClientData>): Promise<void> {
    const { mux } = await this.#ensureAnchor();
    if (socket.data.closed) return;
    const client = await mux.connect({
      send: (frame) => { if (!socket.data.closed) socket.send(frame); },
      close: (code, reason) => { if (!socket.data.closed) socket.close(code, closeReason(reason)); },
    }, socket.data.kind);
    if (socket.data.closed) {
      client.close();
      return;
    }
    socket.data.client = client;
    for (const frame of socket.data.pending.splice(0)) client.receive(frame);
  }

  #message(socket: ServerWebSocket<ClientData>, message: string | Buffer): void {
    if (socket.data.client) {
      socket.data.client.receive(message);
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
    socket.data.client?.close();
    this.#scheduleIdle();
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
