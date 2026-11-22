import { CdpConnection } from "@browser-fabric/worker-runtime/cdp-connection";
import { callExpression, elementByRef, waitForDomQuiet } from "./page-script";

const WORLD_NAME = "fabric-task-agent";
const SETTLE_MAX_MS = 15_000;
/** A tab close is confirmed by Target.targetDestroyed within this time, or requested again. */
const CLOSE_CONFIRM_MS = 750;
const CLOSE_ATTEMPTS = 4;

/** A CDP session of a tab: its top-level page, or an out-of-process iframe (OOPIF) inside it. */
export interface FrameSession {
  sessionId: string;
  targetId: string;
  /** The session that hosts this OOPIF's <iframe> element; undefined for the page itself. */
  parentSessionId?: string;
}

export interface Tab {
  targetId: string;
  sessionId: string;
  /** Whether this run created the tab (and so closes it). */
  owned: boolean;
  sessions: Map<string, FrameSession>;
  loading: boolean;
  /** Increments on every main-frame navigation, including same-document ones. */
  navigations: number;
  /** Isolated worlds by `sessionId|frameId|loaderId`: a new document gets a new world. */
  worlds: Map<string, number>;
  /** Stable short numbers for child frames (refs `f<n>e<id>`); the main frame is 0. */
  frameOrdinals: Map<string, number>;
  /** Frames of the latest snapshot, by ordinal: where refs of that frame resolve. */
  refFrames: Map<number, { sessionId: string; contextId: number }>;
  closed: boolean;
}

export interface ResolvedRef {
  tab: Tab;
  session: FrameSession;
  contextId: number;
  objectId: string;
}

export class StaleRefError extends Error {}

/** A native file chooser the page opened (intercepted, so nothing is shown): the input it is for. */
export interface FileChooser {
  sessionId: string;
  backendNodeId: number;
  mode: "selectSingle" | "selectMultiple";
}

/** A page object handed to `callOn` by reference instead of by value. */
export class RemoteObject {
  public constructor(public readonly objectId: string) {}
}

/** Source usable as a function expression; method shorthand (`name(…) {…}`) gets a `function` keyword. */
export function functionSource(fn: (...args: never[]) => unknown): string {
  const source = fn.toString();
  return /^(async\s+)?(function\b|\(|[\w$]+\s*=>)/.test(source) ? source : `function ${source}`;
}

/**
 * The agent's view of the browser: the tabs it works in (its own tab plus popups those open),
 * their frame sessions, dialogs and navigations. Uses only Page/DOM/Input/Target commands and
 * isolated worlds, never Runtime.enable, so the page sees as little automation as possible.
 */
export class TaskBrowser {
  readonly #tabs = new Map<string, Tab>();
  readonly #notices: string[] = [];
  readonly #pending = new Set<Promise<unknown>>();
  /** Resolvers waiting for Target.targetDestroyed, by target id. */
  readonly #destroyed = new Map<string, () => void>();
  /** Targets being attached, before their tab is registered, and whether they were destroyed meanwhile. */
  readonly #attaching = new Map<string, { destroyed: boolean }>();
  /** Who waits for the next file chooser (see `expectFileChooser`). */
  #chooserWaiter: ((chooser: FileChooser) => void) | undefined;
  #active!: Tab;
  #unsubscribe: () => void;

  private constructor(public readonly connection: CdpConnection, private readonly ownsConnection: boolean) {
    this.#unsubscribe = connection.onMessage((message) => this.#onMessage(message));
  }

  /** Open a new tab (or attach to `targetId`) on a browser-level CDP endpoint or connection. */
  public static async open(options: { cdpEndpoint?: string; connection?: CdpConnection; headers?: Record<string, string>; targetId?: string }): Promise<TaskBrowser> {
    const connection = options.connection ?? await CdpConnection.connect({ endpoint: options.cdpEndpoint!, timeoutMs: 30_000, ...(options.headers ? { headers: options.headers } : {}) });
    const browser = new TaskBrowser(connection, !options.connection);
    try {
      await connection.send("Target.setDiscoverTargets", { discover: true });
      const targetId = options.targetId ?? (await connection.send("Target.createTarget", { url: "about:blank" }) as { targetId: string }).targetId;
      browser.#active = await browser.#attach(targetId, !options.targetId);
      if (browser.#active.closed) throw new Error("The browser tab closed while it was being attached");
      return browser;
    } catch (error) {
      await browser.close(false);
      throw error;
    }
  }

  public get active(): Tab {
    return this.#active;
  }

  /** Events since the last call (dialogs handled, tabs opened or closed), for the next observation. */
  public drainNotices(): string[] {
    return this.#notices.splice(0);
  }

  public send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs?: number): Promise<any> {
    return this.connection.send(method, params, sessionId, timeoutMs);
  }

  /**
   * Attach to a target and register its tab. The target can be destroyed at any point meanwhile (a
   * popup that only started a download closes at once); the returned tab then reports `closed`.
   */
  async #attach(targetId: string, owned: boolean): Promise<Tab> {
    const attaching = { destroyed: false };
    this.#attaching.set(targetId, attaching);
    let sessionId: string;
    try {
      ({ sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string });
    } finally {
      this.#attaching.delete(targetId);
    }
    const tab: Tab = {
      targetId, sessionId, owned, sessions: new Map([[sessionId, { sessionId, targetId }]]), loading: false, navigations: 0,
      worlds: new Map(), frameOrdinals: new Map([[targetId, 0]]), refFrames: new Map(), closed: attaching.destroyed,
    };
    if (tab.closed) return tab;
    this.#tabs.set(targetId, tab);
    await this.send("Page.enable", {}, sessionId);
    await this.#interceptFileChoosers(sessionId);
    await this.#autoAttach(sessionId);
    return tab;
  }

  /**
   * A native file dialog would block a headful browser: Chrome reports it instead, to `upload`
   * waiting for it or as a notice. Needs the Page domain enabled on the session.
   */
  async #interceptFileChoosers(sessionId: string): Promise<void> {
    await this.send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId).catch(() => undefined);
  }

  /**
   * Run `action` (a click) and return the file chooser it opened, or undefined when none opened
   * within `timeoutMs` (or the chooser was for no input element, as the File System Access picker).
   */
  public async expectFileChooser(action: () => Promise<unknown>, timeoutMs: number): Promise<FileChooser | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const opened = new Promise<FileChooser | undefined>((resolve) => {
      this.#chooserWaiter = resolve;
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    });
    try {
      await action();
      return await opened;
    } finally {
      clearTimeout(timer);
      this.#chooserWaiter = undefined;
    }
  }

  async #autoAttach(sessionId: string): Promise<void> {
    await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe" }] }, sessionId).catch(() => undefined);
  }

  #tabOfSession(sessionId: string | undefined): Tab | undefined {
    if (!sessionId) return undefined;
    for (const tab of this.#tabs.values()) if (tab.sessions.has(sessionId)) return tab;
    return undefined;
  }

  #track(promise: Promise<unknown>): void {
    const tracked = promise.catch(() => undefined).finally(() => this.#pending.delete(tracked));
    this.#pending.add(tracked);
  }

  #onMessage(message: Record<string, any>): void {
    const params = message.params ?? {};
    switch (message.method) {
      case "Target.targetCreated": {
        const info = params.targetInfo;
        // A popup (target=_blank, window.open) of one of our tabs becomes the active tab.
        if (info?.type === "page" && info.openerId && this.#tabs.has(info.openerId) && !this.#tabs.has(info.targetId)) {
          this.#track(this.#attach(info.targetId, true).then((tab) => {
            // Gone before it finished attaching: the current tab stays active, and nothing opened for the agent.
            if (tab.closed) return;
            this.#active = tab;
            this.#notices.push("A new tab opened and is now the active tab.");
          }));
        }
        return;
      }
      case "Target.targetDestroyed": {
        this.#destroyed.get(params.targetId)?.();
        const attaching = this.#attaching.get(params.targetId);
        if (attaching) attaching.destroyed = true;
        const tab = this.#tabs.get(params.targetId);
        if (!tab) return;
        tab.closed = true;
        this.#tabs.delete(tab.targetId);
        if (this.#active === tab) {
          const next = [...this.#tabs.values()].at(-1);
          if (next) {
            this.#active = next;
            this.#notices.push("The active tab closed; switched to the previous tab.");
          } else this.#notices.push("The tab was closed.");
        }
        return;
      }
      case "Target.attachedToTarget": {
        const tab = this.#tabOfSession(message.sessionId);
        if (!tab || params.targetInfo?.type !== "iframe") return;
        const child: FrameSession = { sessionId: params.sessionId, targetId: params.targetInfo.targetId, parentSessionId: message.sessionId };
        tab.sessions.set(child.sessionId, child);
        // An OOPIF's file chooser is reported only to its own session. Nested OOPIFs attach through their parent OOPIF.
        this.#track(this.send("Page.enable", {}, child.sessionId).catch(() => undefined)
          .then(() => this.#interceptFileChoosers(child.sessionId))
          .then(() => this.#autoAttach(child.sessionId)));
        return;
      }
      case "Page.fileChooserOpened": {
        if (!this.#tabOfSession(message.sessionId)) return;
        const waiter = this.#chooserWaiter;
        if (waiter && typeof params.backendNodeId === "number") {
          this.#chooserWaiter = undefined;
          waiter({ sessionId: message.sessionId, backendNodeId: params.backendNodeId, mode: params.mode === "selectMultiple" ? "selectMultiple" : "selectSingle" });
        } else this.#notices.push("A file chooser opened and was closed without files; to attach files, use upload on the control you clicked.");
        return;
      }
      case "Target.detachedFromTarget": {
        for (const tab of this.#tabs.values()) tab.sessions.delete(params.sessionId);
        return;
      }
    }
    const tab = this.#tabOfSession(message.sessionId);
    if (!tab || message.sessionId !== tab.sessionId) return;
    const mainFrame = params.frameId === tab.targetId || params.frame?.id === tab.targetId;
    switch (message.method) {
      case "Page.frameNavigated":
        if (!params.frame?.parentId) tab.navigations += 1;
        return;
      case "Page.navigatedWithinDocument":
        if (mainFrame) tab.navigations += 1;
        return;
      case "Page.frameStartedLoading":
        if (mainFrame) tab.loading = true;
        return;
      case "Page.frameStoppedLoading":
        if (mainFrame) tab.loading = false;
        return;
      case "Page.javascriptDialogOpening": {
        // Dialogs block the page; accept alerts/confirms (the agent caused them), dismiss prompts.
        const accept = params.type !== "prompt";
        this.#track(this.send("Page.handleJavaScriptDialog", { accept }, tab.sessionId));
        this.#notices.push(`A ${params.type} dialog said ${JSON.stringify(String(params.message ?? "").slice(0, 300))}; it was ${accept ? "accepted" : "dismissed"}.`);
        return;
      }
    }
  }

  /** Wait for popups being attached, a main-frame load in progress, and a quiet DOM. */
  public async settle(): Promise<void> {
    await Bun.sleep(150);
    await Promise.all(this.#pending);
    const tab = this.#active;
    const deadline = Date.now() + SETTLE_MAX_MS;
    while (tab.loading && !tab.closed && Date.now() < deadline) await Bun.sleep(100);
    const world = await this.mainWorld(tab).catch(() => undefined);
    if (world !== undefined) {
      await this.send("Runtime.evaluate", { expression: callExpression(waitForDomQuiet, 250, 2_000), contextId: world, awaitPromise: true }, tab.sessionId, 5_000).catch(() => undefined);
    }
    await Promise.all(this.#pending);
  }

  /** The isolated world for a frame's current document, created on first use. */
  public async world(tab: Tab, sessionId: string, frameId: string, loaderId: string): Promise<number> {
    const key = `${sessionId}|${frameId}|${loaderId}`;
    const cached = tab.worlds.get(key);
    if (cached !== undefined) return cached;
    const { executionContextId } = await this.send("Page.createIsolatedWorld", { frameId, worldName: WORLD_NAME, grantUniveralAccess: false }, sessionId) as { executionContextId: number };
    for (const existing of tab.worlds.keys()) if (existing.startsWith(`${sessionId}|${frameId}|`)) tab.worlds.delete(existing);
    tab.worlds.set(key, executionContextId);
    return executionContextId;
  }

  public async mainWorld(tab: Tab): Promise<number> {
    const { frameTree } = await this.send("Page.getFrameTree", {}, tab.sessionId);
    return this.world(tab, tab.sessionId, frameTree.frame.id, frameTree.frame.loaderId);
  }

  /** Evaluate a page function in a world and return its JSON result. */
  public async evaluate<T>(sessionId: string, contextId: number, expression: string, timeoutMs = 15_000): Promise<T> {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true }, sessionId, timeoutMs);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? "page script failed");
    return result.value as T;
  }

  /** Call a page function with `this` bound to a resolved element. */
  public async callOn<T>(ref: ResolvedRef, fn: (...args: never[]) => unknown, ...args: unknown[]): Promise<T> {
    const { result, exceptionDetails } = await this.send("Runtime.callFunctionOn", {
      objectId: ref.objectId,
      functionDeclaration: functionSource(fn),
      arguments: args.map((value) => value instanceof RemoteObject ? { objectId: value.objectId } : { value }),
      returnByValue: true,
      awaitPromise: true,
    }, ref.session.sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? "page script failed");
    return result.value as T;
  }

  /**
   * Chrome's own hit test at a point of the ref's session (its local root's coordinates, as
   * DOM.getContentQuads reports them), as an object in the ref's world; undefined when nothing
   * there belongs to that world (another frame, or outside the page).
   */
  public async nodeAt(ref: ResolvedRef, point: { x: number; y: number }): Promise<RemoteObject | undefined> {
    const hit = await this.send("DOM.getNodeForLocation", { x: Math.floor(point.x), y: Math.floor(point.y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false }, ref.session.sessionId)
      .catch(() => undefined) as { backendNodeId?: number } | undefined;
    if (!hit?.backendNodeId) return undefined;
    const resolved = await this.send("DOM.resolveNode", { backendNodeId: hit.backendNodeId, executionContextId: ref.contextId }, ref.session.sessionId).catch(() => undefined);
    const objectId = resolved?.object?.objectId as string | undefined;
    return objectId ? new RemoteObject(objectId) : undefined;
  }

  /** Resolve `e12` / `f2e12` from the latest snapshot of the active tab to a live element. */
  public async resolveRef(ref: string): Promise<ResolvedRef> {
    const match = /^(?:f(\d+))?e(\d+)$/.exec(ref.trim());
    if (!match) throw new Error(`invalid ref ${JSON.stringify(ref)}; use a ref like e12 or f1e3 from the observation`);
    const tab = this.#active;
    const frame = tab.refFrames.get(Number(match[1] ?? 0));
    const session = frame && tab.sessions.get(frame.sessionId);
    const stale = () => new StaleRefError(`ref ${ref} no longer exists (the page changed); use a ref from the latest observation`);
    if (!frame || !session) throw stale();
    const evaluated = await this.send("Runtime.evaluate", { expression: callExpression(elementByRef, Number(match[2])), contextId: frame.contextId }, frame.sessionId).catch(() => undefined);
    const objectId = evaluated?.result?.objectId as string | undefined;
    if (!objectId) throw stale();
    return { tab, session, contextId: frame.contextId, objectId };
  }

  /**
   * Scroll a frame session's <iframe> into view in every ancestor and return the offset of its
   * viewport in top-level page coordinates (input events are dispatched to the page).
   */
  public async frameOffset(tab: Tab, session: FrameSession): Promise<{ x: number; y: number }> {
    if (!session.parentSessionId) return { x: 0, y: 0 };
    const parent = tab.sessions.get(session.parentSessionId);
    if (!parent) throw new Error("the frame's parent is gone");
    const parentOffset = await this.frameOffset(tab, parent);
    const owner = await this.send("DOM.getFrameOwner", { frameId: session.targetId }, parent.sessionId) as { backendNodeId: number };
    await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: owner.backendNodeId }, parent.sessionId).catch(() => undefined);
    const { model } = await this.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId }, parent.sessionId) as { model: { content: number[] } };
    return { x: parentOffset.x + model.content[0]!, y: parentOffset.y + model.content[1]! };
  }

  /**
   * Close a tab and wait until Chrome destroyed it. Target.closeTarget answers before the target
   * is gone, and Chrome drops the request (still answering success) while a failed navigation's
   * error page commits, so the close is repeated until Target.targetDestroyed confirms it.
   */
  public async closeTab(tab: Tab): Promise<void> {
    if (tab.closed) return;
    const destroyed = new Promise<void>((resolve) => this.#destroyed.set(tab.targetId, resolve));
    try {
      for (let attempt = 0; attempt < CLOSE_ATTEMPTS && !tab.closed; attempt++) {
        const requested = await this.send("Target.closeTarget", { targetId: tab.targetId }, undefined, 5_000).then(() => true, () => false);
        if (!requested) return;
        await Promise.race([destroyed, Bun.sleep(CLOSE_CONFIRM_MS)]);
      }
    } finally {
      this.#destroyed.delete(tab.targetId);
    }
  }

  /** Close the tabs this run opened (unless kept) and the connection it opened. */
  public async close(keepTabs: boolean): Promise<void> {
    if (!keepTabs) await Promise.all([...this.#tabs.values()].filter((tab) => tab.owned).map((tab) => this.closeTab(tab)));
    this.#unsubscribe();
    if (this.ownsConnection) this.connection.close();
  }
}
