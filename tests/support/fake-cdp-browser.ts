import type { Server, ServerWebSocket } from "bun";

interface FakeTarget { targetId: string; type: string; title: string; url: string }
type Socket = ServerWebSocket<{ id: number }>;

/**
 * A scripted browser-level CDP server: enough of Target/Browser/Runtime for the fabric endpoint
 * (discovery, flat sessions, /json emulation) without launching Chromium.
 */
export class FakeCdpBrowser {
  readonly targets = new Map<string, FakeTarget>();
  /** Every frame received from a client, in order. */
  readonly received: { connection: number; message: Record<string, any> }[] = [];
  readonly sockets = new Set<Socket>();
  /** Authorization header of every upgrade, in connection order. */
  readonly authorizations: (string | null)[] = [];
  #server?: Server<{ id: number }>;
  #connections = 0;
  #sessions = new Map<string, string>();
  #discovering = new Set<Socket>();
  #nextTarget = 1;

  public constructor(initial: Partial<FakeTarget>[] = [{ url: "about:blank" }]) {
    for (const target of initial) this.addTarget(target);
  }

  public get url(): string { return `ws://127.0.0.1:${this.#server!.port}/devtools/browser/fake`; }
  public get connectionCount(): number { return this.#connections; }

  public start(): this {
    this.#server = Bun.serve<{ id: number }>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) => (this.authorizations.push(request.headers.get("authorization")), server.upgrade(request, { data: { id: ++this.#connections } }) ? undefined : new Response("upgrade required", { status: 426 })),
      websocket: {
        open: (socket) => { this.sockets.add(socket); },
        close: (socket) => { this.sockets.delete(socket); this.#discovering.delete(socket); },
        message: (socket, raw) => this.#handle(socket, JSON.parse(String(raw))),
      },
    });
    return this;
  }

  public stop(): void { this.#server?.stop(true); }

  /** Simulate the browser going away (remote session expiry, crashed Chrome). */
  public dropConnections(): void {
    for (const socket of this.sockets) socket.close(1000, "browser closed");
  }

  public addTarget(partial: Partial<FakeTarget>): FakeTarget {
    const target = { targetId: partial.targetId ?? `T${this.#nextTarget++}`, type: partial.type ?? "page", title: partial.title ?? "", url: partial.url ?? "about:blank" };
    this.targets.set(target.targetId, target);
    this.#broadcast({ method: "Target.targetCreated", params: { targetInfo: target } });
    return target;
  }

  public navigate(targetId: string, url: string): void {
    const target = this.targets.get(targetId)!;
    target.url = url;
    this.#broadcast({ method: "Target.targetInfoChanged", params: { targetInfo: target } });
  }

  /** Send an event to every flat session of a target (for page-socket tests). */
  public emitToTarget(targetId: string, method: string, params: Record<string, unknown> = {}): void {
    for (const socket of this.sockets) for (const [sessionId, owner] of this.#sessions) if (owner === targetId) socket.send(JSON.stringify({ method, params, sessionId }));
  }

  public detach(sessionId: string): void {
    this.#sessions.delete(sessionId);
    this.#broadcastAll({ method: "Target.detachedFromTarget", params: { sessionId } });
  }

  public sessionsFor(targetId: string): string[] {
    return [...this.#sessions].filter(([, owner]) => owner === targetId).map(([sessionId]) => sessionId);
  }

  #broadcast(event: Record<string, unknown>): void {
    for (const socket of this.#discovering) socket.send(JSON.stringify(event));
  }

  #broadcastAll(event: Record<string, unknown>): void {
    for (const socket of this.sockets) socket.send(JSON.stringify(event));
  }

  #handle(socket: Socket, message: Record<string, any>): void {
    this.received.push({ connection: socket.data.id, message });
    const reply = (result: unknown): void => { socket.send(JSON.stringify({ id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) })); };
    const fail = (text: string): void => { socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: text }, ...(message.sessionId ? { sessionId: message.sessionId } : {}) })); };
    const params = message.params ?? {};
    switch (message.method) {
      case "Browser.getVersion":
        return reply({ product: "FakeChrome/1.0", protocolVersion: "1.3", userAgent: "FakeAgent", jsVersion: "1.0", revision: "@fake" });
      case "Target.setDiscoverTargets":
        this.#discovering.add(socket);
        reply({});
        for (const target of this.targets.values()) socket.send(JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: target } }));
        return;
      case "Target.getTargets":
        return reply({ targetInfos: [{ targetId: "B", type: "browser", title: "", url: "" }, ...this.targets.values()] });
      case "Target.getTargetInfo":
        return this.targets.has(params.targetId) ? reply({ targetInfo: this.targets.get(params.targetId) }) : fail("No target with given id found");
      case "Target.createTarget":
        return reply({ targetId: this.addTarget({ url: params.url }).targetId });
      case "Target.closeTarget":
        if (!this.targets.delete(params.targetId)) return fail("No target with given id found");
        this.#broadcast({ method: "Target.targetDestroyed", params: { targetId: params.targetId } });
        return reply({ success: true });
      case "Target.activateTarget":
        return this.targets.has(params.targetId) ? reply({}) : fail("No target with given id found");
      case "Target.attachToTarget": {
        if (!this.targets.has(params.targetId)) return fail("No target with given id found");
        const sessionId = `S-${params.targetId}-${this.#sessions.size + 1}`;
        this.#sessions.set(sessionId, params.targetId);
        return reply({ sessionId });
      }
      case "Runtime.evaluate": {
        const owner = message.sessionId ? this.#sessions.get(message.sessionId) : undefined;
        if (!owner) return fail("Runtime.evaluate needs a page session");
        return reply({ result: { type: "string", value: `${owner}:${params.expression}` } });
      }
      default:
        return reply({});
    }
  }
}
