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
  // is the case Media previously handled through Patchright/Rebrowser.
  challenge: false,
  solved: false,
  ...overrides,
});

/** A deterministic browser-level CDP transport for the guardian; it never evaluates page JavaScript. */
export class FakeCdpTransport implements CdpTransport {
  #listeners = new Map<string, Listener[]>();
  #closed = false;
  readonly commands: Command[] = [];
  readonly #observation: TurnstilePageObservation;
  readonly #frameUrls: string[];
  readonly #documentChildren: unknown[];
  readonly #respond?: (command: Command) => Record<string, unknown> | undefined;

  public constructor(options: {
    observation?: TurnstilePageObservation;
    frameUrl?: string;
    frameUrls?: readonly string[];
    /** Pierced DOM children of the document root, for iframes absent from the frame tree. */
    documentChildren?: unknown[];
    /** Answers a command first; undefined falls back to the default page model. */
    respond?: (command: Command) => Record<string, unknown> | undefined;
  } = {}) {
    this.#observation = options.observation ?? challengeObservation();
    this.#frameUrls = [...(options.frameUrls ?? (options.frameUrl ? [options.frameUrl] : ["https://challenges.cloudflare.com/turnstile/v0/abc"]))];
    this.#documentChildren = options.documentChildren ?? [];
    if (options.respond) this.#respond = options.respond;
  }

  public get readyState(): number { return this.#closed ? 3 : 1; }

  public send(raw: string): void {
    if (this.#closed) throw new Error("CDP transport is closed");
    const command = JSON.parse(raw) as Command;
    this.commands.push(command);
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
      case "Target.attachToTarget":
        return { sessionId: "page-session-1" };
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
        return { root: { nodeName: "#document", backendNodeId: 1, children: this.#documentChildren } };
      case "DOM.getFrameOwner":
        return { backendNodeId: 73 + Math.max(0, Number(String(command.params?.frameId ?? "").split("-").pop()) - 1) };
      case "DOM.getBoxModel":
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
