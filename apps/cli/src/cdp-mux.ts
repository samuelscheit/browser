import type { CdpConnection, CdpTransport } from "@browser-fabric/worker-runtime";

/**
 * Many CDP clients over ONE browser-level connection.
 *
 * Chrome's remote-debugging toggle (chrome://inspect/#remote-debugging) asks the user to allow
 * every new WebSocket, so the endpoint opens exactly one upstream socket and multiplexes every
 * client (Playwright, Puppeteer, MCP servers, the live view, the Turnstile guardian) over it:
 *
 * - Ids: each client frame gets an id from the upstream sequence; its answer is routed back
 *   under the client's own id, so clients may reuse ids freely.
 * - Sessions: flat sessions belong to the client whose attach created them (an explicit
 *   `Target.attachToTarget`, an emulated auto-attach, or a child of a session it owns). Session
 *   traffic only reaches its owner; a client cannot address another client's session.
 * - Browser-level state that Chrome keeps per connection is emulated per client:
 *   `Target.setAutoAttach` (explicit attaches on the client's behalf, attach events before the
 *   `Target.createTarget` answer as Chrome does) and `Target.setDiscoverTargets` (target events
 *   only to subscribers, with their filter). Other browser-level events go to clients that used
 *   that domain at browser level.
 * - A client leaving detaches its sessions, disposes its browser contexts and undoes the
 *   browser-wide settings it made (`X.enable`, download behaviour, permission overrides).
 * - `Browser.close` never closes the shared browser: it closes the tabs and contexts this client
 *   created and then the client's socket.
 */

export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
  openerId?: string;
  browserContextId?: string;
  [key: string]: unknown;
}

type Filter = { type?: string; exclude?: boolean }[];
/** Chrome's default for setAutoAttach and setDiscoverTargets. */
const DEFAULT_FILTER: Filter = [{ type: "browser", exclude: true }, { type: "tab", exclude: true }, {}];
const matches = (filter: Filter, type: string): boolean => {
  for (const entry of filter) if (!entry.type || entry.type === type) return !entry.exclude;
  return false;
};

export interface MuxSink {
  send(text: string): void;
  close(code: number, reason: string): void;
}

/** A browser-socket client, or a `/devtools/page/<id>` client that speaks unscoped CDP to one target. */
export type ClientKind = { kind: "browser" } | { kind: "page"; targetId: string };

export interface MuxClient {
  receive(frame: string | Uint8Array): void;
  close(): void;
}

interface Client {
  readonly sink: MuxSink;
  readonly kind: "browser" | "page";
  /** Sees only targets fabric clients created (the guardian in the user's own Chrome). */
  readonly agentTabsOnly: boolean;
  pageSession?: string;
  closed: boolean;
  autoAttach?: Filter;
  discover?: Filter;
  readonly autoAttached: Map<string, string>;
  readonly attaching: Map<string, Promise<void>>;
  /** Domains used at browser level: their browser-level events reach this client. */
  readonly domains: Set<string>;
  /** Browser-level `X.enable` (and Tracing.start) to undo when the client leaves. */
  readonly enabled: Set<string>;
  /** Browser contexts it created, and whether they go away with it. */
  readonly contexts: Map<string, boolean>;
  readonly created: Set<string>;
  /** Browser context ids ("" = default) whose download behaviour / permissions it changed. */
  readonly downloads: Set<string>;
  readonly permissions: Set<string>;
}

interface Session { owner: Client; targetId: string; parent?: string }

type AttachMode = "client" | "auto" | "page";
interface Pending {
  client: Client;
  /** Absent for frames the multiplexer sends on a client's behalf. */
  clientId?: number;
  method: string;
  params: Record<string, any>;
  sessionId?: string;
  /** A browser-level attach to this target: its attachedToTarget event precedes the answer. */
  attachTarget?: string;
  mode?: AttachMode;
  done?: (ok: boolean) => void;
}

/** A browser-level attachedToTarget event waiting for the attach answer that names its owner. */
interface Stash { event: Record<string, any>; targetId: string; buffered: Record<string, any>[] }

const SESSION_NOT_FOUND = { code: -32001, message: "Session with given id not found." };

function parseFrame(frame: string | Uint8Array): Record<string, any> | undefined {
  try {
    const value = JSON.parse(typeof frame === "string" ? frame : new TextDecoder().decode(frame));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export class CdpMultiplexer {
  readonly #upstream: CdpConnection;
  readonly #log: (message: string) => void;
  readonly #clients = new Set<Client>();
  readonly #sessions = new Map<string, Session>();
  readonly #pending = new Map<number, Pending>();
  readonly #stash = new Map<string, Stash>();
  readonly #attachesInFlight = new Map<string, number>();
  readonly #targets = new Map<string, TargetInfo>();
  /** Targets fabric clients created (and popups they opened). */
  readonly #agentTargets = new Set<string>();
  #closed = false;

  public constructor(upstream: CdpConnection, options: { log?: (message: string) => void } = {}) {
    this.#upstream = upstream;
    this.#log = options.log ?? (() => undefined);
    upstream.onMessage((message) => this.#route(message));
    upstream.onClose(() => this.close("browser connection closed"));
  }

  /** Learn every target (all types) so per-client discovery and auto-attach can be emulated. */
  public async start(): Promise<void> {
    await this.#upstream.send("Target.setDiscoverTargets", { discover: true, filter: [{}] });
  }

  public get targets(): ReadonlyMap<string, TargetInfo> { return this.#targets; }
  public isAgentTarget(targetId: string): boolean { return this.#agentTargets.has(targetId); }

  /** Diagnostics: per client, the sessions it owns and the targets they belong to. */
  public stats(): { clients: number; sessions: number; pending: number; orphanedPending: number; perClient: { agentTabsOnly: boolean; sessions: string[]; targets: string[] }[] } {
    const pending = [...this.#pending.values()];
    return {
      clients: this.#clients.size,
      sessions: this.#sessions.size,
      pending: pending.length,
      /** Frames of clients that left and that the browser will never answer. */
      orphanedPending: pending.filter((entry) => entry.client.closed && !entry.attachTarget && entry.method !== "Target.createBrowserContext").length,
      perClient: [...this.#clients].map((client) => {
        const owned = [...this.#sessions].filter(([, session]) => session.owner === client);
        return { agentTabsOnly: client.agentTabsOnly, sessions: owned.map(([id]) => id), targets: [...new Set(owned.map(([, session]) => session.targetId))] };
      }),
    };
  }

  /** A target created outside a client's CDP connection (the endpoint's `/json/new`). */
  public adopt(targetId: string): void {
    if (this.#agentTargets.has(targetId)) return;
    this.#agentTargets.add(targetId);
    const info = this.#targets.get(targetId);
    if (!info) return;
    for (const client of this.#clients) {
      if (!client.agentTabsOnly) continue;
      if (client.discover && matches(client.discover, info.type)) this.#deliver(client, { method: "Target.targetCreated", params: { targetInfo: info } });
      if (client.autoAttach && this.#autoAttachable(client, info)) void this.#ensureAutoAttached(client, targetId);
    }
  }

  public async connect(sink: MuxSink, kind: ClientKind): Promise<MuxClient> {
    const client = this.#addClient(sink, kind.kind, false);
    if (kind.kind === "page") {
      const attached = await new Promise<boolean>((resolve) => this.#request(client, "Target.attachToTarget", { targetId: kind.targetId, flatten: true }, { attachTarget: kind.targetId, mode: "page", done: resolve }));
      if (!attached) {
        this.#disconnect(client);
        throw new Error(`No such target ${kind.targetId}`);
      }
    }
    return this.#handle(client);
  }

  /**
   * An in-process browser-level client as a CdpTransport, for CdpConnection-based companions (the
   * Turnstile guardian) that must not open a second upstream socket.
   */
  public transport(options: { agentTabsOnly: boolean }): CdpTransport {
    type Listener = (event: any) => void;
    const listeners = { open: new Set<Listener>(), message: new Set<Listener>(), close: new Set<Listener>(), error: new Set<Listener>() };
    let state = 1;
    const emit = (type: keyof typeof listeners, event: unknown) => { for (const listener of [...listeners[type]]) listener(event); };
    const finish = () => {
      if (state === 3) return;
      state = 3;
      queueMicrotask(() => emit("close", {}));
    };
    // Async delivery keeps the companion's handlers out of the multiplexer's routing stack.
    const client = this.#addClient({ send: (text) => queueMicrotask(() => { if (state === 1) emit("message", { data: text }); }), close: finish }, "browser", options.agentTabsOnly);
    const handle = this.#handle(client);
    return {
      get readyState() { return state; },
      send: (message) => { if (state === 1) handle.receive(message); },
      close: () => { handle.close(); finish(); },
      addEventListener: (type, listener, opts) => {
        const wrapped: Listener = opts?.once ? (event) => { listeners[type].delete(wrapped); listener(event); } : listener;
        listeners[type].add(wrapped);
      },
      removeEventListener: (type, listener) => { listeners[type].delete(listener); },
    };
  }

  /** The browser went away (or the endpoint stops): every client loses its sessions with it. */
  public close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const client of this.#clients) {
      client.closed = true;
      client.sink.close(1011, reason);
    }
    this.#clients.clear();
    this.#sessions.clear();
    this.#stash.clear();
    for (const pending of this.#pending.values()) pending.done?.(false);
    this.#pending.clear();
  }

  #addClient(sink: MuxSink, kind: "browser" | "page", agentTabsOnly: boolean): Client {
    if (this.#closed) throw new Error("browser connection closed");
    const client: Client = {
      sink, kind, agentTabsOnly, closed: false,
      autoAttached: new Map(), attaching: new Map(), domains: new Set(), enabled: new Set(),
      contexts: new Map(), created: new Set(), downloads: new Set(), permissions: new Set(),
    };
    this.#clients.add(client);
    return client;
  }

  #handle(client: Client): MuxClient {
    return { receive: (frame) => this.#receive(client, frame), close: () => this.#disconnect(client) };
  }

  #visible(client: Client, targetId: string): boolean {
    return !client.agentTabsOnly || this.#agentTargets.has(targetId);
  }

  #autoAttachable(client: Client, info: TargetInfo): boolean {
    return info.type !== "browser" && this.#visible(client, info.targetId) && matches(client.autoAttach!, info.type);
  }

  #owns(client: Client, sessionId: unknown): boolean {
    return typeof sessionId === "string" && this.#sessions.get(sessionId)?.owner === client;
  }

  // ---------------------------------------------------------------- client → browser

  #receive(client: Client, frame: string | Uint8Array): void {
    if (client.closed) return;
    const message = parseFrame(frame);
    if (!message) return;
    if (typeof message.id !== "number" || typeof message.method !== "string") {
      if (typeof message.id === "number") this.#replyError(client, message.id, { code: -32600, message: "Message must have a string 'method' property" }, message.sessionId);
      return;
    }
    const params: Record<string, any> = message.params && typeof message.params === "object" ? message.params : {};
    if (client.kind === "page" && message.sessionId === undefined) message.sessionId = client.pageSession;
    if (message.sessionId !== undefined) {
      if (!this.#owns(client, message.sessionId)) return this.#replyError(client, message.id, SESSION_NOT_FOUND, message.sessionId);
      if (message.method === "Target.detachFromTarget" && params.sessionId !== undefined && !this.#owns(client, params.sessionId)) return this.#replyError(client, message.id, SESSION_NOT_FOUND, message.sessionId);
      return this.#forward(client, message.id, message.method, params, message.sessionId);
    }

    const { id, method } = message;
    const domain = method.slice(0, method.indexOf("."));
    client.domains.add(domain);
    switch (method) {
      case "Target.setAutoAttach":
        return void this.#setAutoAttach(client, id, params);
      case "Target.setDiscoverTargets":
        return this.#setDiscoverTargets(client, id, params);
      case "Browser.close":
        return void this.#closeBrowser(client, id);
      case "Browser.crash":
      case "Browser.crashGpuProcess":
        return this.#replyError(client, id, { code: -32000, message: `${method} is not allowed: fabric shares this browser with other clients` });
      case "Target.detachFromTarget": {
        const sessionId = params.sessionId ?? [...this.#sessions].find(([, session]) => session.owner === client && !session.parent && session.targetId === params.targetId)?.[0];
        if (!this.#owns(client, sessionId)) return this.#replyError(client, id, { code: -32602, message: "No session with given id" });
        return this.#forward(client, id, method, { sessionId });
      }
      case "Target.sendMessageToTarget":
        if (!this.#owns(client, params.sessionId)) return this.#replyError(client, id, { code: -32602, message: "No session with given id" });
        break;
      case "Target.attachToTarget":
        if (!this.#visible(client, params.targetId)) return this.#replyError(client, id, { code: -32602, message: "No target with given id found" });
        return this.#forward(client, id, method, params, undefined, { attachTarget: String(params.targetId), mode: "client" });
      case "Target.attachToBrowserTarget": {
        const browser = [...this.#targets.values()].find((target) => target.type === "browser");
        return this.#forward(client, id, method, params, undefined, browser ? { attachTarget: browser.targetId, mode: "client" } : {});
      }
      case "Tracing.start":
        client.enabled.add("Tracing");
        break;
      case "Tracing.end":
        client.enabled.delete("Tracing");
        break;
      case "Browser.setDownloadBehavior":
        if (params.behavior === "default") client.downloads.delete(params.browserContextId ?? "");
        else client.downloads.add(params.browserContextId ?? "");
        break;
      case "Browser.grantPermissions":
      case "Browser.setPermission":
        client.permissions.add(params.browserContextId ?? "");
        break;
      case "Browser.resetPermissions":
        client.permissions.delete(params.browserContextId ?? "");
        break;
      default:
        if (method.endsWith(".enable")) client.enabled.add(domain);
        else if (method.endsWith(".disable")) client.enabled.delete(domain);
    }
    this.#forward(client, id, method, params);
  }

  #forward(client: Client, clientId: number, method: string, params: Record<string, any>, sessionId?: string, extra: Partial<Pending> = {}): void {
    let id: number;
    try {
      id = this.#upstream.sendFrame({ method, params, ...(sessionId ? { sessionId } : {}) });
    } catch (error) {
      return this.#replyError(client, clientId, { code: -32000, message: error instanceof Error ? error.message : String(error) }, sessionId);
    }
    if (extra.attachTarget) this.#attachesInFlight.set(extra.attachTarget, (this.#attachesInFlight.get(extra.attachTarget) ?? 0) + 1);
    this.#pending.set(id, { client, clientId, method, params, ...(sessionId ? { sessionId } : {}), ...extra });
  }

  /** A frame the multiplexer sends on a client's behalf; `done` learns whether it succeeded. */
  #request(client: Client, method: string, params: Record<string, any>, extra: Partial<Pending>): void {
    let id: number;
    try {
      id = this.#upstream.sendFrame({ method, params });
    } catch {
      extra.done?.(false);
      return;
    }
    if (extra.attachTarget) this.#attachesInFlight.set(extra.attachTarget, (this.#attachesInFlight.get(extra.attachTarget) ?? 0) + 1);
    this.#pending.set(id, { client, method, params, ...extra });
  }

  /** Fire-and-forget housekeeping (detach, dispose, disable) whose answer nobody needs. */
  #housekeeping(method: string, params: Record<string, unknown>): void {
    if (this.#closed || this.#upstream.closed) return;
    this.#upstream.send(method, params).catch((error) => this.#log(`${method} after a client left failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  async #setAutoAttach(client: Client, id: number, params: Record<string, any>): Promise<void> {
    if (params.autoAttach) {
      if (params.flatten !== true) return this.#replyError(client, id, { code: -32000, message: "fabric multiplexes one browser connection: browser-level Target.setAutoAttach needs flatten: true" });
      client.autoAttach = Array.isArray(params.filter) ? params.filter : DEFAULT_FILTER;
      // Chrome attaches every existing target before it answers.
      await Promise.all([...this.#targets.values()].filter((info) => this.#autoAttachable(client, info)).map((info) => this.#ensureAutoAttached(client, info.targetId)));
    } else {
      client.autoAttach = undefined;
      // Chrome detaches the auto-attached sessions (their detachedFromTarget events precede this answer).
      await Promise.all([...client.autoAttached.values()].map((sessionId) => this.#upstream.send("Target.detachFromTarget", { sessionId }).catch(() => undefined)));
    }
    this.#replyResult(client, id, {});
  }

  #setDiscoverTargets(client: Client, id: number, params: Record<string, any>): void {
    if (params.discover) {
      client.discover = Array.isArray(params.filter) ? params.filter : DEFAULT_FILTER;
      for (const info of this.#targets.values()) {
        if (this.#visible(client, info.targetId) && matches(client.discover, info.type)) this.#deliver(client, { method: "Target.targetCreated", params: { targetInfo: info } });
      }
    } else {
      client.discover = undefined;
    }
    this.#replyResult(client, id, {});
  }

  #ensureAutoAttached(client: Client, targetId: string): Promise<void> {
    if (client.closed || client.autoAttached.has(targetId)) return Promise.resolve();
    const running = client.attaching.get(targetId);
    if (running) return running;
    const task = new Promise<void>((resolve) => this.#request(client, "Target.attachToTarget", { targetId, flatten: true }, { attachTarget: targetId, mode: "auto", done: () => resolve() }))
      .finally(() => client.attaching.delete(targetId));
    client.attaching.set(targetId, task);
    return task;
  }

  /** Close what this client created; the shared browser keeps running. */
  async #closeBrowser(client: Client, id: number): Promise<void> {
    const contexts = [...client.contexts.keys()];
    const targets = [...client.created].filter((targetId) => this.#targets.has(targetId));
    client.contexts.clear();
    client.created.clear();
    await Promise.all([
      ...contexts.map((browserContextId) => this.#upstream.send("Target.disposeBrowserContext", { browserContextId }).catch(() => undefined)),
      ...targets.map((targetId) => this.#upstream.send("Target.closeTarget", { targetId }).catch(() => undefined)),
    ]);
    this.#replyResult(client, id, {});
    client.sink.close(1000, "Browser.close closed this client's tabs; the shared browser keeps running");
  }

  #disconnect(client: Client): void {
    if (client.closed) return;
    client.closed = true;
    this.#clients.delete(client);
    for (const [sessionId, session] of [...this.#sessions]) {
      if (session.owner !== client) continue;
      // Children go away with their root session.
      if (!session.parent) this.#housekeeping("Target.detachFromTarget", { sessionId });
      this.#forget(sessionId);
    }
    for (const [browserContextId, dispose] of client.contexts) if (dispose) this.#housekeeping("Target.disposeBrowserContext", { browserContextId });
    const others = [...this.#clients];
    for (const domain of client.enabled) {
      if (others.some((other) => other.enabled.has(domain))) continue;
      this.#housekeeping(domain === "Tracing" ? "Tracing.end" : `${domain}.disable`, {});
    }
    const live = (contextId: string) => contextId === "" || !client.contexts.get(contextId);
    for (const contextId of client.downloads) {
      if (live(contextId) && !others.some((other) => other.downloads.has(contextId))) this.#housekeeping("Browser.setDownloadBehavior", { behavior: "default", ...(contextId ? { browserContextId: contextId } : {}) });
    }
    for (const contextId of client.permissions) {
      if (live(contextId) && !others.some((other) => other.permissions.has(contextId))) this.#housekeeping("Browser.resetPermissions", contextId ? { browserContextId: contextId } : {});
    }
  }

  // ---------------------------------------------------------------- browser → clients

  #route(message: Record<string, any>): void {
    if (this.#closed) return;
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      this.#answer(pending, message);
      return;
    }
    if (typeof message.method !== "string") return;
    if (typeof message.sessionId === "string") this.#sessionEvent(message);
    else this.#browserEvent(message);
  }

  #sessionEvent(message: Record<string, any>): void {
    const stashed = this.#stash.get(message.sessionId);
    if (stashed) {
      stashed.buffered.push(message);
      return;
    }
    const session = this.#sessions.get(message.sessionId);
    if (!session) return;
    if (message.method === "Target.attachedToTarget" && typeof message.params?.sessionId === "string") {
      this.#sessions.set(message.params.sessionId, { owner: session.owner, targetId: message.params.targetInfo?.targetId, parent: message.sessionId });
    } else if (message.method === "Target.detachedFromTarget" && typeof message.params?.sessionId === "string") {
      this.#forget(message.params.sessionId);
    }
    this.#deliver(session.owner, message);
  }

  #browserEvent(message: Record<string, any>): void {
    const params = message.params ?? {};
    switch (message.method) {
      case "Target.targetCreated":
      case "Target.targetInfoChanged": {
        const info = params.targetInfo as TargetInfo | undefined;
        if (!info?.targetId) return;
        this.#targets.set(info.targetId, info);
        const created = message.method === "Target.targetCreated";
        if (created && info.openerId && this.#agentTargets.has(info.openerId)) this.#agentTargets.add(info.targetId);
        for (const client of this.#clients) {
          if (!this.#visible(client, info.targetId)) continue;
          if (client.discover && matches(client.discover, info.type)) this.#deliver(client, message);
          if (created && client.autoAttach && this.#autoAttachable(client, info)) void this.#ensureAutoAttached(client, info.targetId);
        }
        return;
      }
      case "Target.targetDestroyed":
      case "Target.targetCrashed": {
        const info = this.#targets.get(params.targetId);
        for (const client of this.#clients) {
          if (info && client.discover && this.#visible(client, info.targetId) && matches(client.discover, info.type)) this.#deliver(client, message);
        }
        if (message.method === "Target.targetDestroyed") {
          this.#targets.delete(params.targetId);
          this.#agentTargets.delete(params.targetId);
        }
        return;
      }
      case "Target.attachedToTarget": {
        const targetId = params.targetInfo?.targetId;
        if ((this.#attachesInFlight.get(targetId) ?? 0) > 0) {
          this.#stash.set(params.sessionId, { event: message, targetId, buffered: [] });
        } else {
          this.#log(`detaching an unrequested session on ${params.targetInfo?.type} ${targetId}`);
          this.#housekeeping("Target.detachFromTarget", { sessionId: params.sessionId });
        }
        return;
      }
      case "Target.detachedFromTarget": {
        this.#stash.delete(params.sessionId);
        const session = this.#sessions.get(params.sessionId);
        if (!session) return;
        this.#forget(params.sessionId);
        const owner = session.owner;
        if (owner.kind === "page" && owner.pageSession === params.sessionId) owner.sink.close(1000, "target closed");
        else this.#deliver(owner, message);
        return;
      }
      case "Target.receivedMessageFromTarget": {
        const session = this.#sessions.get(params.sessionId);
        if (session) this.#deliver(session.owner, message);
        return;
      }
      default: {
        const domain = message.method.slice(0, message.method.indexOf("."));
        for (const client of this.#clients) if (client.kind === "browser" && client.domains.has(domain)) this.#deliver(client, message);
      }
    }
  }

  #answer(pending: Pending, message: Record<string, any>): void {
    const { client } = pending;
    const sessionId: string | undefined = typeof message.result?.sessionId === "string" ? message.result.sessionId : undefined;
    let stash: Stash | undefined;
    if (pending.attachTarget) {
      stash = sessionId ? this.#stash.get(sessionId) : undefined;
      if (sessionId) this.#stash.delete(sessionId);
      const left = (this.#attachesInFlight.get(pending.attachTarget) ?? 1) - 1;
      if (left > 0) this.#attachesInFlight.set(pending.attachTarget, left);
      else {
        this.#attachesInFlight.delete(pending.attachTarget);
        for (const [orphan, entry] of this.#stash) {
          if (entry.targetId !== pending.attachTarget) continue;
          this.#stash.delete(orphan);
          this.#housekeeping("Target.detachFromTarget", { sessionId: orphan });
        }
      }
    }

    if (client.closed || (pending.mode === "auto" && !client.autoAttach)) {
      // The client left (or stopped auto-attaching) while this was in flight: undo what it created.
      if (sessionId && (pending.method === "Target.attachToTarget" || pending.method === "Target.attachToBrowserTarget")) this.#housekeeping("Target.detachFromTarget", { sessionId });
      if (pending.method === "Target.createBrowserContext" && message.result?.browserContextId && pending.params.disposeOnDetach !== false) {
        this.#housekeeping("Target.disposeBrowserContext", { browserContextId: message.result.browserContextId });
      }
      pending.done?.(false);
      return;
    }

    if (pending.mode && sessionId) {
      this.#sessions.set(sessionId, { owner: client, targetId: pending.attachTarget!, ...(pending.sessionId ? { parent: pending.sessionId } : {}) });
      if (pending.mode === "client" && stash) this.#deliver(client, stash.event);
      if (pending.mode === "auto") {
        client.autoAttached.set(pending.attachTarget!, sessionId);
        const info = (stash?.event.params.targetInfo as TargetInfo | undefined) ?? this.#targets.get(pending.attachTarget!);
        this.#deliver(client, { method: "Target.attachedToTarget", params: { sessionId, targetInfo: { ...info, attached: true }, waitingForDebugger: false } });
      }
      if (pending.mode === "page") client.pageSession = sessionId;
      for (const buffered of stash?.buffered ?? []) this.#sessionEvent(buffered);
    }
    if (pending.clientId === undefined) {
      pending.done?.(!message.error);
      return;
    }

    const result = message.result;
    if (!message.error) {
      switch (pending.method) {
        case "Target.createBrowserContext":
          if (result?.browserContextId) client.contexts.set(result.browserContextId, pending.params.disposeOnDetach !== false);
          break;
        case "Target.disposeBrowserContext":
          client.contexts.delete(pending.params.browserContextId);
          break;
        case "Target.getTargets":
          if (client.agentTabsOnly && Array.isArray(result?.targetInfos)) result.targetInfos = result.targetInfos.filter((info: TargetInfo) => this.#agentTargets.has(info.targetId));
          break;
        case "Target.createTarget": {
          const targetId = result?.targetId;
          if (typeof targetId !== "string" || pending.sessionId) break;
          client.created.add(targetId);
          this.adopt(targetId);
          // Chrome auto-attaches a new target before it answers createTarget; Playwright relies on it.
          if (client.autoAttach && matches(client.autoAttach, this.#targets.get(targetId)?.type ?? "page")) {
            void this.#ensureAutoAttached(client, targetId).then(() => this.#reply(client, pending, message));
            return;
          }
          break;
        }
      }
    }
    this.#reply(client, pending, message);
  }

  #forget(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#sessions.delete(sessionId);
    if (session.owner.autoAttached.get(session.targetId) === sessionId) session.owner.autoAttached.delete(session.targetId);
    // Chrome never answers what was in flight on a detached session.
    for (const [id, pending] of this.#pending) {
      if (pending.sessionId !== sessionId) continue;
      this.#pending.delete(id);
      if (pending.clientId === undefined) pending.done?.(false);
      else if (!pending.client.closed) this.#replyError(pending.client, pending.clientId, { code: -32001, message: "Session with given id not found." }, sessionId);
    }
    for (const [child, entry] of [...this.#sessions]) if (entry.parent === sessionId) this.#forget(child);
  }

  #deliver(client: Client, message: Record<string, any>): void {
    if (client.closed) return;
    if (client.kind === "page" && message.sessionId !== undefined && message.sessionId === client.pageSession) {
      const { sessionId: _scoped, ...unscoped } = message;
      client.sink.send(JSON.stringify(unscoped));
      return;
    }
    client.sink.send(JSON.stringify(message));
  }

  #reply(client: Client, pending: Pending, message: Record<string, any>): void {
    this.#deliver(client, { id: pending.clientId, ...(message.error ? { error: message.error } : { result: message.result ?? {} }), ...(pending.sessionId ? { sessionId: pending.sessionId } : {}) });
  }

  #replyResult(client: Client, id: number, result: Record<string, unknown>): void {
    this.#deliver(client, { id, result });
  }

  #replyError(client: Client, id: number, error: { code: number; message: string }, sessionId?: unknown): void {
    this.#deliver(client, { id, error, ...(typeof sessionId === "string" ? { sessionId } : {}) });
  }
}
