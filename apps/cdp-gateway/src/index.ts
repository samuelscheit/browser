import { FabricError, type BrowserSessionId, type ProjectId, type WorkerId } from "@browser-fabric/contracts";
import { BrowserScheduler, CapabilitySigner, certificateFingerprintFromForwardedHeader, certificateFingerprintsEqual, forwardedClientCertificate } from "@browser-fabric/control-plane";
import { ReverseCdpRelayRegistry, type RelaySocket, RELAY_OPEN, RELAY_CLOSED } from "./reverse-relay";

export interface CdpSocket extends RelaySocket {}

export interface CdpUpstream {
  connect(sessionId: BrowserSessionId, internalEndpoint: string): Promise<CdpSocket>;
}

export interface GatewayConnectionData {
  kind?: "external";
  sessionId: BrowserSessionId;
  capability: string;
  internalEndpoint: string;
  upstream?: CdpSocket;
  /** A reverse relay is owned by the federated worker, not by an external CDP client. */
  upstreamIsReverse?: boolean;
  onUpstreamMessage?: (event: any) => void;
  onUpstreamClose?: () => void;
  onUpstreamError?: () => void;
  registered: boolean;
  bufferedMessages: (string | Buffer<ArrayBuffer>)[];
}

interface ReverseConnectionData { kind: "reverse"; workerId: WorkerId; leaseId: string; relay?: CdpSocket; }
type GatewaySocketData = GatewayConnectionData | ReverseConnectionData;

export interface GatewayAuthenticationContext {
  /** External raw-CDP users are authorized against this exact session project. */
  kind: "cdp" | "worker_relay";
  project?: ProjectId;
}

export interface CdpGatewayOptions {
  scheduler: BrowserScheduler;
  capabilitySigner: CapabilitySigner;
  upstream: CdpUpstream;
  /** Must represent certificate verification and, for CDP, project authorization at the ingress. */
  authenticate?(request: Request, context: GatewayAuthenticationContext): Promise<boolean> | boolean;
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
  readonly #reverseRelays: ReverseCdpRelayRegistry;

  public constructor(options: CdpGatewayOptions) {
    this.#scheduler = options.scheduler;
    this.#capabilities = options.capabilitySigner;
    this.#upstream = options.upstream;
    this.#authenticate = options.authenticate;
    this.#maxBufferedMessages = options.maxBufferedMessages ?? 64;
    this.#reverseRelays = new ReverseCdpRelayRegistry();
    if (this.#maxBufferedMessages < 1 || this.#maxBufferedMessages > 10_000) throw new Error("maxBufferedMessages is outside safe bounds");
  }

  /** Attach an outbound federated-worker relay to one claimed lease. */
  public async authorizeReverseRelay(request: Request): Promise<{ workerId: WorkerId; leaseId: string }> {
    const url = new URL(request.url);
    const match = /^\/v1\/worker-relay\/(worker_[A-Za-z0-9_-]+)\/(browser-lease_[A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (!match) throw new FabricError("not_found", "worker relay route not found", 404);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new FabricError("validation_failed", "worker relay requires a WebSocket upgrade", 426);
    const workerId = match[1] as WorkerId;
    const leaseId = match[2]!;
    if (this.#authenticate && !(await this.#authenticate(request, { kind: "worker_relay" }))) throw new FabricError("authentication_required", "mutual TLS worker principal is required", 401);
    const snapshot = await this.#scheduler.store.snapshot();
    const worker = snapshot.workers.get(workerId);
    const lease = snapshot.leases.get(leaseId);
    // `x-fabric-worker-cert-fingerprint` exists only for direct/local test transports. At the
    // production edge Traefik clears it before forwarding the verified client PEM, so the
    // forwarded certificate fingerprint is the authoritative worker identity. The production
    // server authenticator requires that forwarded certificate; this fallback cannot authorize a
    // public request by itself.
    const claimedFingerprint = request.headers.get("x-fabric-worker-cert-fingerprint");
    const forwardedFingerprint = certificateFingerprintFromForwardedHeader(forwardedClientCertificate(request));
    const fingerprint = forwardedFingerprint ?? claimedFingerprint;
    if (
      !worker ||
      !worker.isLocal ||
      !lease ||
      lease.workerId !== workerId ||
      lease.status !== "active" ||
      !fingerprint ||
      (claimedFingerprint !== null && forwardedFingerprint !== undefined && !certificateFingerprintsEqual(claimedFingerprint, forwardedFingerprint)) ||
      !certificateFingerprintsEqual(fingerprint, worker.certificateFingerprint)
    ) {
      throw new FabricError("authorization_denied", "worker relay is not authorized for this active local lease", 403);
    }
    return { workerId, leaseId };
  }

  /** Validate an upgrade request and return the immutable data attached to the Bun socket. */
  public async authorizeUpgrade(request: Request): Promise<GatewayConnectionData> {
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
    if (this.#authenticate && !(await this.#authenticate(request, { kind: "cdp", project: internalSession.project }))) {
      throw new FabricError("authorization_denied", "mutual TLS principal is not granted access to this session project", 403);
    }
    this.#capabilities.verify(capability, {
      sessionId,
      project: internalSession.project,
      ...(internalSession.profileRef === undefined ? {} : { profileRef: internalSession.profileRef }),
      workerId: session.workerId as WorkerId,
    });
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
  public createBunServeOptions(port: number, hostname = "0.0.0.0"): Bun.Serve.Options<GatewaySocketData> {
    return {
      port,
      hostname,
      websocket: {
        data: {} as GatewaySocketData,
        maxPayloadLength: 16 * 1024 * 1024,
        backpressureLimit: 32 * 1024 * 1024,
        open: (socket) => void this.#openAny(socket),
        message: (socket, message) => this.#messageAny(socket, message),
        close: (socket) => void this.#closeAny(socket)
      },
      fetch: async (request, server) => {
        try {
          if (/^\/v1\/worker-relay\//.test(new URL(request.url).pathname)) {
            const relay = await this.authorizeReverseRelay(request);
            const data = { kind: "reverse" as const, ...relay };
            if (!server.upgrade(request, { data })) return new Response("WebSocket upgrade failed", { status: 400 });
            return undefined;
          }
          const data = await this.authorizeUpgrade(request);
          if (!server.upgrade(request, { data })) return new Response("WebSocket upgrade failed", { status: 400 });
          return undefined;
        } catch (error) {
          return problemResponse(error);
        }
      }
    };
  }

  #openAny(socket: Bun.ServerWebSocket<GatewaySocketData>): void {
    if (socket.data.kind === "reverse") {
      const relay = new BunRelaySocket(socket as Bun.ServerWebSocket<ReverseConnectionData>);
      this.#reverseRelays.register(`${socket.data.workerId}:${socket.data.leaseId}`, relay);
      socket.data.relay = relay;
      return;
    }
    void this.#openExternal(socket as Bun.ServerWebSocket<GatewayConnectionData>);
  }

  #messageAny(socket: Bun.ServerWebSocket<GatewaySocketData>, message: string | Buffer<ArrayBuffer>): void {
    if (socket.data.kind === "reverse") { (socket.data.relay as BunRelaySocket | undefined)?.emit("message", { data: message }); return; }
    this.#messageExternal(socket as Bun.ServerWebSocket<GatewayConnectionData>, message);
  }

  #closeAny(socket: Bun.ServerWebSocket<GatewaySocketData>): void {
    if (socket.data.kind === "reverse") {
      (socket.data.relay as BunRelaySocket | undefined)?.emit("close", {});
      // A reconnect may have registered a replacement before Bun delivers this old socket's
      // close callback. Remove only the exact relay that closed; unconditionally removing by key
      // would disconnect the fresh worker relay and make a healthy browser look unavailable.
      this.#reverseRelays.remove(`${socket.data.workerId}:${socket.data.leaseId}`, socket.data.relay);
      return;
    }
    void this.#closeExternal(socket as Bun.ServerWebSocket<GatewayConnectionData>);
  }

  async #openExternal(socket: Bun.ServerWebSocket<GatewayConnectionData>): Promise<void> {
    const data = socket.data;
    try {
      await this.#scheduler.registerExternalCdpConnection(data.sessionId, data.capability);
      data.registered = true;
      const upstreamIsReverse = data.internalEndpoint.startsWith("reverse://");
      const upstream = upstreamIsReverse
        ? await this.#reverseRelays.waitFor(reverseRelayKey(data.internalEndpoint))
        : await this.#upstream.connect(data.sessionId, data.internalEndpoint);
      data.upstream = upstream;
      data.upstreamIsReverse = upstreamIsReverse;
      if (upstream.readyState !== WebSocket.OPEN) await waitForWebSocketOpen(upstream);
      const onUpstreamMessage = (event: any) => {
        try {
          if (socket.data === data) socket.send(event.data as string | ArrayBuffer);
        } catch {
          socket.close(1011, "gateway send failed");
        }
      };
      const onUpstreamClose = () => socket.close(1000, "browser closed");
      const onUpstreamError = () => socket.close(1011, "browser upstream error");
      data.onUpstreamMessage = onUpstreamMessage;
      data.onUpstreamClose = onUpstreamClose;
      data.onUpstreamError = onUpstreamError;
      upstream.addEventListener("message", onUpstreamMessage);
      upstream.addEventListener("close", onUpstreamClose, { once: true });
      upstream.addEventListener("error", onUpstreamError, { once: true });
      for (const message of data.bufferedMessages.splice(0)) {
        if (upstream.readyState !== WebSocket.OPEN) break;
        upstream.send(message);
      }
    } catch {
      socket.close(1011, "browser CDP upstream unavailable");
      await this.#closeExternal(socket);
    }
  }

  #messageExternal(socket: Bun.ServerWebSocket<GatewayConnectionData>, message: string | Buffer<ArrayBuffer>): void {
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

  async #closeExternal(socket: Bun.ServerWebSocket<GatewayConnectionData>): Promise<void> {
    const data = socket.data;
    try {
      // A local worker's reverse socket is a lease-scoped control connection. Closing it merely
      // because one external CDP client disconnected would kill the browser relay and break the
      // documented reconnect grace. Detach this client's listeners but leave that worker-owned
      // socket alive; direct managed-worker upstreams remain per-client and are closed normally.
      if (data.upstream) {
        if (data.onUpstreamMessage) data.upstream.removeEventListener?.("message", data.onUpstreamMessage);
        if (data.onUpstreamClose) data.upstream.removeEventListener?.("close", data.onUpstreamClose);
        if (data.onUpstreamError) data.upstream.removeEventListener?.("error", data.onUpstreamError);
        if (!data.upstreamIsReverse && (data.upstream.readyState === WebSocket.OPEN || data.upstream.readyState === WebSocket.CONNECTING)) data.upstream.close(1000, "client disconnected");
      }
    } finally {
      data.upstream = undefined;
      data.upstreamIsReverse = undefined;
      data.onUpstreamMessage = undefined;
      data.onUpstreamClose = undefined;
      data.onUpstreamError = undefined;
      data.bufferedMessages.length = 0;
      if (data.registered) {
        data.registered = false;
        await this.#scheduler.unregisterExternalCdpConnection(data.sessionId).catch(() => undefined);
      }
    }
  }
}

function reverseRelayKey(endpoint: string): string {
  const match = /^reverse:\/\/(worker_[A-Za-z0-9_-]+)\/(browser-lease_[A-Za-z0-9_-]+)$/.exec(endpoint);
  if (!match) throw new FabricError("worker_unavailable", "local worker relay endpoint is malformed", 503);
  return `${match[1]}:${match[2]}`;
}

class BunRelaySocket implements CdpSocket {
  readonly #listeners = new Map<string, Set<(event: any) => void>>();
  readonly #wrappers = new Map<string, Map<(event: any) => void, (event: any) => void>>();
  readonly #socket: Bun.ServerWebSocket<any>;
  public constructor(socket: Bun.ServerWebSocket<any>) { this.#socket = socket; }
  get readyState(): number { return this.#socket.readyState; }
  send(data: string | ArrayBuffer | Uint8Array): void { this.#socket.send(data); }
  close(code?: number, reason?: string): void { this.#socket.close(code, reason); }
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void, options?: { once?: boolean }): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    const wrappers = this.#wrappers.get(type) ?? new Map();
    // Mirror DOM EventTarget semantics: removeEventListener receives the original callback even
    // when the caller registered it with `{ once: true }`. This matters for each external CDP
    // reconnect because a worker-owned reverse relay must not retain listeners for old clients.
    const wrapped = options?.once
      ? (event: any) => { this.removeEventListener(type, listener); listener(event); }
      : listener;
    wrappers.set(listener, wrapped);
    this.#wrappers.set(type, wrappers);
    listeners.add(wrapped);
    this.#listeners.set(type, listeners);
  }
  removeEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void {
    const wrapper = this.#wrappers.get(type)?.get(listener) ?? listener;
    this.#listeners.get(type)?.delete(wrapper);
    this.#wrappers.get(type)?.delete(listener);
  }
  emit(type: "open" | "message" | "close" | "error", event: any): void { for (const listener of this.#listeners.get(type) ?? []) listener(event); }
}

async function waitForWebSocketOpen(socket: CdpSocket, timeoutMs = 10_000): Promise<void> {
  if (socket.readyState === RELAY_OPEN) return;
  if (socket.readyState === RELAY_CLOSED) throw new Error("CDP upstream is closed");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("CDP upstream open timed out")); }, timeoutMs);
    const onOpen = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("CDP upstream failed to open")); };
    const cleanup = () => { clearTimeout(timer); socket.removeEventListener?.("open", onOpen); socket.removeEventListener?.("error", onError); };
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
