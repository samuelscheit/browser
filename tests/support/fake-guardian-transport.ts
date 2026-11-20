import type { CaptchaGuardianOptions, CaptchaSolve, CdpTransport, SolveResult } from "@browser-fabric/worker-runtime";

type Listener = { callback: (event: any) => void; once: boolean };
export type Command = { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };

/**
 * A deterministic browser-level CDP transport for the guardian: pages `page-N` with sessions
 * `page-session-N`, and out-of-process frame targets that attach as `frame-session:<id>`. It never
 * evaluates page JavaScript; `respond` answers a command first.
 */
export class FakeCdpTransport implements CdpTransport {
  #listeners = new Map<string, Listener[]>();
  #closed = false;
  readonly commands: Command[] = [];
  readonly #pages: { targetId: string; url: string }[];
  readonly #frameTargets: Set<string>;
  readonly #respond?: (command: Command) => Record<string, unknown> | undefined;

  public constructor(options: {
    pages?: { targetId: string; url: string }[];
    frameTargets?: string[];
    respond?: (command: Command) => Record<string, unknown> | undefined;
  } = {}) {
    this.#pages = options.pages ?? [{ targetId: "page-1", url: "https://example.test/protected?case=secret" }];
    this.#frameTargets = new Set(options.frameTargets ?? []);
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
    this.#listeners.set(type, (this.#listeners.get(type) ?? []).filter((listener) => listener.callback !== callback));
  }

  #emit(type: string, event: any): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener.callback(event);
      if (listener.once) this.removeEventListener(type as "message", listener.callback);
    }
  }

  #result(command: Command): Record<string, unknown> {
    switch (command.method) {
      case "Target.getTargets":
        return { targetInfos: this.#pages.map(({ targetId, url }) => ({ targetId, type: "page", url })) };
      case "Target.attachToTarget": {
        const targetId = String(command.params?.targetId);
        if (this.#frameTargets.has(targetId)) {
          // Chromium announces the new session before answering the attach.
          const sessionId = `frame-session:${targetId}`;
          this.emitEvent("Target.attachedToTarget", { sessionId, targetInfo: { targetId, type: "iframe", url: "https://challenges.cloudflare.com/x" } });
          return { sessionId };
        }
        const index = this.#pages.findIndex((page) => page.targetId === targetId);
        return index >= 0 ? { sessionId: `page-session-${index + 1}` } : { error: { message: "No target with given id found" } };
      }
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "top", url: this.#pages[0]?.url ?? "about:blank", loaderId: "loader-1" } } };
      default:
        return {};
    }
  }

  public emitEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.#emit("message", { data: JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }) });
  }

  /** A top-level navigation of the page whose session is `sessionId`. */
  public navigate(sessionId: string, url: string): void {
    this.emitEvent("Page.frameNavigated", { frame: { id: "top", url, loaderId: `loader-${Math.random()}` } }, sessionId);
  }

  public sent(method: string, sessionId?: string): Command[] {
    return this.commands.filter((command) => command.method === method && (sessionId === undefined || command.sessionId === sessionId));
  }
}

type SolveOptions = Parameters<CaptchaSolve>[1];
type Driver = Parameters<CaptchaSolve>[0];

/** One llm-captcha session the guardian started; the test decides how it ends. */
export interface SolveCall {
  driver: Driver;
  options: SolveOptions;
  finish(result: Partial<SolveResult> & Pick<SolveResult, "state">): void;
  fail(error: Error): void;
}

/** Stands in for llm-captcha's `solve`, so lifecycle tests decide each session's outcome. */
export class ScriptedSolve {
  readonly calls: SolveCall[] = [];

  public readonly solve: CaptchaSolve = (driver, options) => new Promise<SolveResult>((resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    this.calls.push({
      driver,
      options,
      finish: (result) => resolve({ detail: "", rounds: [], ...result }),
      fail: reject,
    });
  });
}

/** Waits for `predicate` on the monotonic clock. */
export async function eventually(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export type GuardianLog = { event: string; details?: Record<string, unknown> };

/** Guardian options for a fake browser: a fast poll and the scripted solver. */
export function fakeGuardianOptions(transport: FakeCdpTransport, scripted: ScriptedSolve, logs: GuardianLog[] = []): CaptchaGuardianOptions {
  return {
    endpoint: "ws://browser.test/devtools/browser/fake",
    transportFactory: async () => transport,
    pollIntervalMs: 250,
    solve: scripted.solve,
    logger: (event, details) => logs.push({ event, ...(details ? { details } : {}) }),
  };
}
