import {
  TURNSTILE_OBSERVATION_SCRIPT,
  type CdpTransport,
  type TurnstilePageObservation,
} from "@browser-fabric/worker-runtime";

type Listener = { callback: (event: any) => void; once: boolean };
export const ISOLATED_CONTEXT_ID = 7;
export type Command = { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };

export const challengeObservation = (overrides: Partial<TurnstilePageObservation> = {}): TurnstilePageObservation => ({
  url: "https://example.test/protected",
  title: "Just a moment…",
  signals: ["title-marker"],
  // The guardian's CDP frame-tree pass supplies the actual Turnstile signal
  // and bounding box. This models a widget inside a closed shadow root, which
  // is the case a stealth-patched driver would otherwise have to handle per application.
  challenge: false,
  solved: false,
  ...overrides,
});

/**
 * What a Turnstile widget shows. `booting` is its frame document before the widget rendered into it;
 * `expired`, `timeout` and `error` are the failure panels after the first (`failed`).
 */
export type FakeWidgetState = "interactive" | "verifying" | "succeeded" | "failed" | "expired" | "timeout" | "error" | "booting";

/**
 * A Turnstile widget in an out-of-process frame, modeled on Chromium's pierced DOM of a real one:
 * randomized ids and classes, a closed shadow root holding an aria-live box with the checkbox
 * panel, the verifying panel, five role=alert verdict panels (success first), and branding.
 * Panels other than the shown one are `display: none`, so they have no box model.
 */
export class FakeTurnstileWidget {
  public state: FakeWidgetState;
  /** The state a click on the widget leads to; the widget ignores the click when undefined. */
  public onClick?: FakeWidgetState;
  public clicks = 0;

  public constructor(state: FakeWidgetState = "interactive", onClick?: FakeWidgetState) {
    this.state = state;
    if (onClick) this.onClick = onClick;
  }

  public click(): void {
    this.clicks += 1;
    if (this.onClick) this.state = this.onClick;
  }

  public document(): Record<string, unknown> {
    const element = (nodeId: number, nodeName: string, attributes: string[] = [], children: unknown[] = []) => ({ nodeId, backendNodeId: 1_000 + nodeId, nodeType: 1, nodeName, localName: nodeName.toLowerCase(), attributes, children });
    const random = (nodeId: number) => ["id", `_${(nodeId * 2_654_435_761 >>> 0).toString(16)}`, "class", `_${(nodeId * 40_503 >>> 0).toString(16)}`];
    const panel = (nodeId: number, role?: string) => element(nodeId, "DIV", [...random(nodeId), ...(role ? ["role", role] : []), "style", "display: none;"], [element(nodeId + 100, "SPAN")]);
    const widget = {
      nodeId: 4, backendNodeId: 1_004, nodeType: 11, nodeName: "#document-fragment", shadowRootType: "closed",
      children: [element(5, "DIV", [...random(5), "aria-live", "polite", "aria-atomic", "true"], [
        element(6, "DIV", random(6), [element(7, "LABEL", random(7), [element(8, "INPUT", ["type", "checkbox"]), element(16, "SPAN", random(16))])]),
        panel(9),
        panel(10, "alert"), panel(11, "alert"), panel(12, "alert"), panel(13, "alert"), panel(14, "alert"),
        element(15, "DIV", random(15), [element(17, "A", ["href", "https://www.cloudflare.com/"])]),
      ])],
    };
    const body = { ...element(3, "BODY"), ...(this.state === "booting" ? {} : { shadowRoots: [widget] }) };
    return { nodeId: 1, backendNodeId: 1_001, nodeType: 9, nodeName: "#document", children: [element(2, "HTML", [], [body])] };
  }

  /** Nodes with a layout box in the current state. */
  public rendered(nodeId: number): boolean {
    const shown: Record<FakeWidgetState, number[]> = {
      interactive: [6, 7, 8, 16], verifying: [9], succeeded: [10], failed: [11], expired: [12], timeout: [13], error: [14], booting: [],
    };
    if (nodeId <= 3) return true;
    if (this.state === "booting") return false;
    return [5, 15, 17, ...shown[this.state]].includes(nodeId);
  }
}

/** A deterministic browser-level CDP transport for the guardian; it never evaluates page JavaScript. */
export class FakeCdpTransport implements CdpTransport {
  #listeners = new Map<string, Listener[]>();
  #closed = false;
  readonly commands: Command[] = [];
  readonly #observation: TurnstilePageObservation;
  readonly #frameUrls: string[];
  readonly #documentChildren: unknown[];
  readonly #respond?: (command: Command) => Record<string, unknown> | undefined;
  /** The widget every frame-tree frame renders out of process; `undefined` frames have no own target. */
  readonly widget?: FakeTurnstileWidget;

  public constructor(options: {
    observation?: TurnstilePageObservation;
    frameUrl?: string;
    frameUrls?: readonly string[];
    /** Pierced DOM children of the document root, for iframes absent from the frame tree. */
    documentChildren?: unknown[];
    /**
     * The widget in the frame-tree frames, an interactive one that ignores clicks by default. With
     * `null` the frames have no target of their own and no readable document.
     */
    widget?: FakeTurnstileWidget | null;
    /** Answers a command first; undefined falls back to the default page model. */
    respond?: (command: Command) => Record<string, unknown> | undefined;
  } = {}) {
    this.#observation = options.observation ?? challengeObservation();
    this.#frameUrls = [...(options.frameUrls ?? (options.frameUrl ? [options.frameUrl] : ["https://challenges.cloudflare.com/turnstile/v0/abc"]))];
    this.#documentChildren = options.documentChildren ?? [];
    if (options.widget !== null) this.widget = options.widget ?? new FakeTurnstileWidget();
    if (options.respond) this.#respond = options.respond;
  }

  /** Frame-tree frame ids with the URL each one's target reports. */
  #frames(): Map<string, string> {
    return new Map(this.#frameUrls.map((url, index) => [`turnstile-frame-${index + 1}`, url]));
  }

  public get readyState(): number { return this.#closed ? 3 : 1; }

  public send(raw: string): void {
    if (this.#closed) throw new Error("CDP transport is closed");
    const command = JSON.parse(raw) as Command;
    this.commands.push(command);
    // The browser routes the click to whichever frame is under the pointer: here, the widget.
    if (command.method === "Input.dispatchMouseEvent" && command.params?.type === "mouseReleased") this.widget?.click();
    queueMicrotask(() => {
      const response = this.#respond?.(command) ?? this.#result(command);
      const error = (response as { error?: unknown }).error;
      this.#emit("message", { data: JSON.stringify(error ? { id: command.id, error } : { id: command.id, result: response }) });
    });
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#emit("close", {});
  }

  public addEventListener(type: "open" | "message" | "close" | "error", callback: (event: any) => void, options?: { once?: boolean }): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push({ callback, once: options?.once === true });
    this.#listeners.set(type, listeners);
  }

  public removeEventListener(type: "open" | "message" | "close" | "error", callback: (event: any) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    this.#listeners.set(type, listeners.filter((listener) => listener.callback !== callback));
  }

  #emit(type: string, event: any): void {
    const listeners = [...(this.#listeners.get(type) ?? [])];
    for (const listener of listeners) {
      listener.callback(event);
      if (listener.once) this.removeEventListener(type as "open" | "message" | "close" | "error", listener.callback);
    }
  }

  #result(command: Command): Record<string, unknown> {
    switch (command.method) {
      case "Target.getTargets":
        return { targetInfos: [{ targetId: "page-1", type: "page", url: this.#observation.url }] };
      case "Target.getTargetInfo":
        {
          const url = this.widget ? this.#frames().get(String(command.params?.targetId)) : undefined;
          return url ? { targetInfo: { targetId: command.params?.targetId, type: "iframe", url } } : { error: { message: "No target with given id found" } };
        }
      case "Target.attachToTarget":
        {
          const targetId = String(command.params?.targetId);
          if (!(this.widget && this.#frames().has(targetId))) return { sessionId: "page-session-1" };
          // Chromium announces the new session before answering it.
          const sessionId = `frame-session:${targetId}`;
          this.emitEvent("Target.attachedToTarget", { sessionId, targetInfo: { targetId, type: "iframe", url: this.#frames().get(targetId) } });
          return { sessionId };
        }
      case "Page.createIsolatedWorld":
        return { executionContextId: ISOLATED_CONTEXT_ID };
      case "Runtime.evaluate":
        return command.params?.expression === TURNSTILE_OBSERVATION_SCRIPT && command.params?.contextId === ISOLATED_CONTEXT_ID
          ? { result: { type: "object", value: this.#observation } }
          : { result: { type: "undefined" } };
      case "Page.getFrameTree":
        return {
          frameTree: {
            frame: { id: "top", url: this.#observation.url },
            childFrames: this.#frameUrls.map((url, index) => ({ frame: { id: `turnstile-frame-${index + 1}`, url } })),
          },
        };
      case "DOM.getDocument":
        if (this.widget && command.sessionId?.startsWith("frame-session:")) return { root: this.widget.document() };
        return { root: { nodeName: "#document", backendNodeId: 1, children: this.#documentChildren } };
      case "DOM.getFrameOwner":
        return { backendNodeId: 73 + Math.max(0, Number(String(command.params?.frameId ?? "").split("-").pop()) - 1) };
      case "DOM.getBoxModel":
        if (command.sessionId?.startsWith("frame-session:")) {
          const nodeId = Number(command.params?.nodeId);
          return this.widget?.rendered(nodeId) ? { model: { border: [0, 0, 24, 0, 24, 24, 0, 24], width: 24, height: 24 } } : { error: { message: "Could not compute box model." } };
        }
        {
          const offset = (Number(command.params?.backendNodeId ?? 73) - 73) * 340;
          return { model: { content: [10 + offset, 20, 310 + offset, 20, 310 + offset, 100, 10 + offset, 100] } };
        }
      case "DOM.resolveNode":
        return { object: { objectId: `frame-owner-${command.params?.backendNodeId}` } };
      case "Runtime.callFunctionOn":
        return { result: { type: "boolean", value: true } };
      default:
        return {};
    }
  }

  public emitEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.#emit("message", { data: JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }) });
  }
}

export function inputEvents(transport: FakeCdpTransport): Command[] {
  return transport.commands.filter((command) => command.method === "Input.dispatchMouseEvent");
}

export function buttonEvents(transport: FakeCdpTransport): Command[] {
  return inputEvents(transport).filter((command) => command.params?.type === "mousePressed" || command.params?.type === "mouseReleased");
}

/** Page observations the guardian ran: one per poll of the page. */
export function observationPolls(transport: FakeCdpTransport): number {
  return transport.commands.filter((command) => command.method === "Runtime.evaluate" && command.params?.expression === TURNSTILE_OBSERVATION_SCRIPT).length;
}

/** Waits for `predicate` on the monotonic clock, so tests that freeze Date.now() still time out. */
export async function eventually(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Waits until the guardian has polled the page `count` more times. */
export async function morePolls(transport: FakeCdpTransport, count: number, timeoutMs = 5_000): Promise<void> {
  const target = observationPolls(transport) + count;
  await eventually(() => observationPolls(transport) >= target, timeoutMs);
}
