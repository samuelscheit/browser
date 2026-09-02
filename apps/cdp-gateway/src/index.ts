import { FabricError, type BrowserSessionId, type WorkerId } from "@browser-fabric/contracts";
import { BrowserScheduler, CapabilitySigner } from "@browser-fabric/control-plane";

export interface CdpUpstream {
  connect(sessionId: BrowserSessionId, internalEndpoint: string): Promise<WebSocket>;
}

export interface GatewayConnectionData {
  sessionId: BrowserSessionId;
  capability: string;
  internalEndpoint: string;
  upstream?: WebSocket;
  registered: boolean;
  bufferedMessages: (string | Buffer<ArrayBuffer>)[];
}

export interface CdpGatewayOptions {
  scheduler: BrowserScheduler;
  capabilitySigner: CapabilitySigner;
  upstream: CdpUpstream;
  /** Must represent a certificate verification performed by the private ingress. */
  authenticate?(request: Request): Promise<boolean> | boolean;
  maxBufferedMessages?: number;
}

/**
 * Browser-level WebSocket relay. It forwards complete CDP frames and never exposes a
 * command-by-command HTTP proxy. The Bun adapter performs capability validation before upgrade.
 */
export class CdpGateway {
  readonly #scheduler: BrowserScheduler;
  readonly #capabilities: CapabilitySigner;
  readonly #upstream: CdpUpstream;
  readonly #authenticate?: CdpGatewayOptions["authenticate"];
  readonly #maxBufferedMessages: number;

  public constructor(options: CdpGatewayOptions) {
    this.#scheduler = options.scheduler;
    this.#capabilities = options.capabilitySigner;
    this.#upstream = options.upstream;
    this.#authenticate = options.authenticate;
    this.#maxBufferedMessages = options.maxBufferedMessages ?? 64;
    if (this.#maxBufferedMessages < 1 || this.#maxBufferedMessages > 10_000) throw new Error("maxBufferedMessages is outside safe bounds");
  }

  /** Validate an upgrade request and return the immutable data attached to the Bun socket. */
  public async authorizeUpgrade(request: Request): Promise<GatewayConnectionData> {
    if (this.#authenticate && !(await this.#authenticate(request))) throw new FabricError("authentication_required", "mutual TLS principal is required", 401);
    const url = new URL(request.url);
    const match = /^\/v1\/cdp\/(browser-session_[A-Za-z0-9]+)$/.exec(url.pathname);
    if (!match) throw new FabricError("not_found", "CDP route not found", 404);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new FabricError("validation_failed", "CDP endpoint only accepts WebSocket upgrade", 426);
    const sessionId = match[1] as BrowserSessionId;
    const capability = url.searchParams.get("cap");
    if (!capability) throw new FabricError("authentication_required", "CDP capability is required", 401);
    const session = await this.#scheduler.getSession(sessionId);
    const internalSession = (await this.#scheduler.store.snapshot()).sessions.get(sessionId);
    if (!session.workerId || !internalSession?.cdpInternalEndpoint) throw new FabricError("invalid_state", "CDP session is not assigned to a worker", 409);
    this.#capabilities.verify(capability, { sessionId, workerId: session.workerId as WorkerId });
    return { sessionId, capability, internalEndpoint: internalSession.cdpInternalEndpoint, registered: false, bufferedMessages: [] };
  }

  /** HTTP fallback for non-Bun adapters; callers should use createBunServeOptions for upgrades. */
  public async fetch(request: Request): Promise<Response> {
    try {
      await this.authorizeUpgrade(request);
      return new Response(JSON.stringify(new FabricError("validation_failed", "use a WebSocket upgrade for CDP", 426).toProblem()), { status: 426, headers: { "content-type": "application/problem+json" } });
    } catch (error) {
      return problemResponse(error);
    }
  }

  /**
   * Return Bun.serve options. Authentication is performed before `server.upgrade`; no unauthenticated
   * socket is ever accepted. Upstream sockets are worker-local and are never sent to the client.
   */
  public createBunServeOptions(port: number, hostname = "0.0.0.0"): Bun.Serve.Options<GatewayConnectionData> {
    return {
      port,
      hostname,
      websocket: {
        data: {} as GatewayConnectionData,
        maxPayloadLength: 16 * 1024 * 1024,
        backpressureLimit: 32 * 1024 * 1024,
        open: (socket) => void this.#open(socket),
        message: (socket, message) => this.#message(socket, message),
        close: (socket) => void this.#close(socket)
      },
      fetch: async (request, server) => {
        try {
          const data = await this.authorizeUpgrade(request);
          if (!server.upgrade(request, { data })) return new Response("WebSocket upgrade failed", { status: 400 });
          return undefined;
        } catch (error) {
          return problemResponse(error);
        }
      }
    };
  }

  async #open(socket: Bun.ServerWebSocket<GatewayConnectionData>): Promise<void> {
    const data = socket.data;
    try {
      await this.#scheduler.registerExternalCdpConnection(data.sessionId, data.capability);
      data.registered = true;
      const upstream = await this.#upstream.connect(data.sessionId, data.internalEndpoint);
      data.upstream = upstream;
      if (upstream.readyState !== WebSocket.OPEN) await waitForWebSocketOpen(upstream);
      upstream.addEventListener("message", (event) => {
        try {
          if (socket.data === data) socket.send(event.data as string | ArrayBuffer);
        } catch {
          socket.close(1011, "gateway send failed");
        }
      });
      upstream.addEventListener("close", () => socket.close(1000, "browser closed"), { once: true });
      upstream.addEventListener("error", () => socket.close(1011, "browser upstream error"), { once: true });
      for (const message of data.bufferedMessages.splice(0)) {
        if (upstream.readyState !== WebSocket.OPEN) break;
        upstream.send(message);
      }
    } catch {
      socket.close(1011, "browser CDP upstream unavailable");
      await this.#close(socket);
    }
  }

  #message(socket: Bun.ServerWebSocket<GatewayConnectionData>, message: string | Buffer<ArrayBuffer>): void {
    const data = socket.data;
    if (data.upstream?.readyState === WebSocket.OPEN) {
      data.upstream.send(message);
      return;
    }
    if (data.bufferedMessages.length >= this.#maxBufferedMessages) {
      socket.close(1013, "upstream backpressure");
      return;
    }
    data.bufferedMessages.push(message);
  }

  async #close(socket: Bun.ServerWebSocket<GatewayConnectionData>): Promise<void> {
    const data = socket.data;
    try {
      if (data.upstream && (data.upstream.readyState === WebSocket.OPEN || data.upstream.readyState === WebSocket.CONNECTING)) data.upstream.close(1000, "client disconnected");
    } finally {
      data.bufferedMessages.length = 0;
      if (data.registered) {
        data.registered = false;
        await this.#scheduler.unregisterExternalCdpConnection(data.sessionId).catch(() => undefined);
      }
    }
  }
}

async function waitForWebSocketOpen(socket: WebSocket, timeoutMs = 10_000): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) throw new Error("CDP upstream is closed");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("CDP upstream open timed out")); }, timeoutMs);
    const onOpen = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("CDP upstream failed to open")); };
    const cleanup = () => { clearTimeout(timer); socket.removeEventListener("open", onOpen); socket.removeEventListener("error", onError); };
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

function problemResponse(error: unknown): Response {
  const body = error instanceof FabricError ? error.toProblem() : new FabricError("internal_error", "CDP gateway failure", 500).toProblem();
  return new Response(JSON.stringify(body), { status: error instanceof FabricError ? error.status : 500, headers: { "content-type": "application/problem+json" } });
}

export class NativeWebSocketUpstream implements CdpUpstream {
  public async connect(_sessionId: BrowserSessionId, internalEndpoint: string): Promise<WebSocket> {
    let websocketEndpoint = internalEndpoint;
    const parsed = new URL(internalEndpoint);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      const versionUrl = new URL(parsed.toString());
      versionUrl.pathname = `${versionUrl.pathname.replace(/\/$/, "")}/json/version`;
      const response = await fetch(versionUrl);
      if (!response.ok) throw new FabricError("worker_unavailable", `browser CDP discovery returned HTTP ${response.status}`, 503);
      const body = await response.json() as { webSocketDebuggerUrl?: unknown };
      if (typeof body.webSocketDebuggerUrl !== "string") throw new FabricError("worker_unavailable", "browser CDP discovery returned no websocket endpoint", 503);
      const discovered = new URL(body.webSocketDebuggerUrl);
      // Chromium reports a loopback URL from inside its container. Replace only the authority
      // with the private service authority; retain the browser-specific path and query.
      discovered.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
      discovered.host = parsed.host;
      websocketEndpoint = discovered.toString();
    }
    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(websocketEndpoint);
      socket.addEventListener("open", () => resolve(socket), { once: true });
      socket.addEventListener("error", () => reject(new FabricError("worker_unavailable", "browser CDP upstream connection failed", 503)), { once: true });
    });
  }
}
