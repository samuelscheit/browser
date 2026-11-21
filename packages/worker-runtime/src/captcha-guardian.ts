/**
 * Process-level CAPTCHA guardian.
 *
 * One guardian attaches to each Fabric-owned Chromium process independently of application CDP
 * clients. It installs the GPU identity on every page and runs llm-captcha's solver on each one: the
 * solver finds challenges in every frame (out-of-process frames and closed shadow roots included) and
 * solves them with trusted CDP input and, for challenges beyond a checkbox, slider or press-and-hold,
 * a vision model. Model traffic goes through the injected models only; their key never reaches a page.
 *
 * Per page there is at most one solve session at a time. A session that fails is final for its page
 * document (no paid loops); a top-level navigation starts over. A visible reCAPTCHA v2 widget whose
 * response is still empty after a session gets one provider token per document when the recipe
 * enables a provider (captcha-solvers/recaptcha-fallback.ts explains why), and the page reads `solved`
 * for it only once a token is in.
 */
import { BUILTIN_ADAPTERS, CdpDriver, solve as llmCaptchaSolve, type CdpHost, type CdpSession, type SolveResult } from "llm-captcha-solver";
import {
  DEFAULT_CAPTCHA_MAX_ROUNDS,
  DEFAULT_CAPTCHA_POLL_INTERVAL_MS,
  DEFAULT_CAPTCHA_SOLVE_TIMEOUT_MS,
  type CaptchaGuardianFactory,
  type CaptchaGuardianHandle,
  type CaptchaGuardianLogger,
  type CaptchaGuardianOptions,
  type CaptchaGuardianSnapshot,
  type CaptchaGuardianSpec,
  type CaptchaModels,
} from "./captcha-guardian-types";
import { BROWSER_FINGERPRINT_SCRIPT } from "./browser-fingerprint";
import { injectRecaptchaToken, probePendingRecaptcha, recaptchaWorld, type PendingRecaptcha } from "./captcha-solvers/recaptcha-fallback";
import { CdpConnection, DEFAULT_CDP_CONNECT_TIMEOUT_MS } from "./cdp-connection";

export {
  DEFAULT_CAPTCHA_MAX_ROUNDS,
  DEFAULT_CAPTCHA_POLL_INTERVAL_MS,
  DEFAULT_CAPTCHA_SOLVE_TIMEOUT_MS,
} from "./captcha-guardian-types";
/** llm-captcha's session outcome and its built-in adapters, for owners and tests of the guardian. */
export { BUILTIN_ADAPTERS, type SolveResult } from "llm-captcha-solver";
export type {
  CaptchaGuardianFactory,
  CaptchaGuardianFactoryInput,
  CaptchaGuardianHandle,
  CaptchaGuardianLogger,
  CaptchaGuardianOptions,
  CaptchaGuardianSnapshot,
  CaptchaGuardianSpec,
  CaptchaModels,
  CaptchaSolve,
} from "./captcha-guardian-types";

type AttachedPage = {
  targetId: string;
  sessionId: string;
  url: string;
  /** Child-frame navigation must not start a new document. */
  mainFrameId?: string;
  /** Advances on every top-level document; work for an older document is void. */
  document: number;
  /** One driver per document, so its isolated worlds are injected once. */
  driver?: GuardianDriver;
  /** The solve session in flight. */
  solving?: AbortController;
  /** The document's session failed: no further attempt until the page navigates. */
  failed: boolean;
  /** The last session's outcome, so a solved document is reported once. */
  lastState?: SolveResult["state"];
  /** The guardian's isolated world in this document, for the reCAPTCHA probe and token. */
  world?: Promise<number | undefined>;
  /** Since when a session ended with a visible reCAPTCHA whose response is empty. */
  recaptchaSince?: number;
  /** Out-of-process frame sessions the solver holds, by frame id (which is the frame's target id). */
  frames: Map<string, Promise<string | undefined>>;
};

const RANGES = {
  pollIntervalMs: [250, 30_000],
  solveTimeoutMs: [10_000, 600_000],
  maxRounds: [1, 20],
} as const;

function numberInRange(name: keyof typeof RANGES | "connectTimeoutMs", value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const [min, max] = name === "connectTimeoutMs" ? [500, 60_000] : RANGES[name];
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`CAPTCHA guardian ${name} ${value} is outside ${min}..${max}`);
  if (name === "maxRounds" && !Number.isInteger(value)) throw new Error(`CAPTCHA guardian maxRounds ${value} must be an integer`);
  return Math.round(value);
}

export const defaultCaptchaGuardianSpec = (): CaptchaGuardianSpec => ({
  enabled: true,
  pollIntervalMs: DEFAULT_CAPTCHA_POLL_INTERVAL_MS,
  solveTimeoutMs: DEFAULT_CAPTCHA_SOLVE_TIMEOUT_MS,
  maxRounds: DEFAULT_CAPTCHA_MAX_ROUNDS,
});

/** A guardian factory whose guardians ask `models`; without models only model-free challenges are solved. */
export function createCaptchaGuardianFactory(options: { models?: CaptchaModels } = {}): CaptchaGuardianFactory {
  return ({ endpoint, spec, tokenSolver }) => new CaptchaGuardian({
    endpoint,
    pollIntervalMs: spec.pollIntervalMs,
    solveTimeoutMs: spec.solveTimeoutMs,
    maxRounds: spec.maxRounds,
    ...(options.models?.length ? { models: options.models } : {}),
    ...(tokenSolver ? { tokenSolver } : {}),
  });
}

export const defaultCaptchaGuardianFactory: CaptchaGuardianFactory = createCaptchaGuardianFactory();

/** Validate a guardian declaration before a runtime may launch Chromium. */
export function assertCaptchaGuardianSpec(spec: CaptchaGuardianSpec): void {
  if (!spec || spec.enabled !== true) throw new Error("Fabric browser runtimes must enable the CAPTCHA guardian");
  for (const name of Object.keys(RANGES) as (keyof typeof RANGES)[]) numberInRange(name, spec[name], 0);
}

/**
 * Parse only bounded tuning knobs. There intentionally is no disable switch: every Fabric CDP
 * Chromium process carries this companion.
 */
export function captchaGuardianSpecFromEnvironment(env: Record<string, string | undefined> = process.env): CaptchaGuardianSpec {
  const asNumber = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
    return value;
  };
  const spec = {
    enabled: true,
    pollIntervalMs: asNumber("FABRIC_CAPTCHA_POLL_INTERVAL_MS", DEFAULT_CAPTCHA_POLL_INTERVAL_MS),
    solveTimeoutMs: asNumber("FABRIC_CAPTCHA_SOLVE_TIMEOUT_MS", DEFAULT_CAPTCHA_SOLVE_TIMEOUT_MS),
    maxRounds: asNumber("FABRIC_CAPTCHA_MAX_ROUNDS", DEFAULT_CAPTCHA_MAX_ROUNDS),
  } satisfies CaptchaGuardianSpec;
  assertCaptchaGuardianSpec(spec);
  return spec;
}

/** Page URLs are logged as their origin only; anything else of a page never reaches telemetry. */
function safePageLocation(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.length > 8_192) return /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)?.[1]?.toLowerCase() ?? "opaque";
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : parsed.protocol.slice(0, -1);
  } catch {
    return undefined;
  }
}

/** CDP and model errors can echo page details or request data; retain only a stable error class. */
export function safeErrorKind(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(error.name) ? error.name : "Error";
}

/** llm-captcha details are adapter ids and fixed reasons; keep them bounded and plain all the same. */
function safeDetail(detail: string): string {
  return detail.replace(/[^\w :.,()-]/g, "").slice(0, 160);
}

/** The adapter a failed session worked on: its detail names it (`recaptcha-images: not solved in 8 rounds`). */
function failedAdapter(result: SolveResult): string | undefined {
  return /^([a-z0-9-]+):/.exec(result.detail)?.[1] ?? result.snapshot?.adapter ?? result.rounds.at(-1)?.view.adapter;
}

/** How long a visible reCAPTCHA may stay without a response after an idle or token-less solved session. */
const DEFAULT_RECAPTCHA_GRACE_MS = 5_000;

function defaultLogger(event: string, details?: Record<string, unknown>): void {
  if (details) console.info(`[fabric-guardian] ${event}`, details);
  else console.info(`[fabric-guardian] ${event}`);
}

type PageState = Parameters<CdpDriver["publish"]>[0];

/**
 * llm-captcha's CDP driver as the guardian runs it.
 *
 * - No assist mode: without a model, llm-captcha would put a model challenge to whoever drives the
 *   browser in a panel on the page and wait for the answer; inside a Fabric browser nobody is asked,
 *   so such a challenge ends `failed` at once instead.
 * - The engine's own `failed` never reaches the page: clients stop on `failed` and release the
 *   browser, which would kill a reCAPTCHA token fallback still to come. The guardian publishes the
 *   final word itself with {@link show}, once it knows whether that fallback runs.
 */
class GuardianDriver extends CdpDriver {
  public constructor(host: CdpHost) {
    super(host);
    // The engine checks `driver.ask` before falling back to assist mode.
    Object.defineProperty(this, "ask", { value: undefined });
  }

  /** The engine's publish: `solving` and `solved` go through; `failed` is the guardian's to say. */
  public override async publish(state: PageState, detail: string): Promise<void> {
    if (state !== "failed") await this.show(state, detail);
  }

  /** Sets `<html data-captcha-state data-captcha-detail>` of the document. */
  public async show(state: PageState, detail: string): Promise<void> {
    await super.publish(state, detail);
  }
}

/** A command for a page document that is gone; the solver's work for it stops at the next CDP call. */
class StaleDocumentError extends Error {
  public constructor() {
    super("page document is gone");
    this.name = "StaleDocumentError";
  }
}

/**
 * Watches every page target in one browser and solves the challenges on them. Application CDP clients
 * may attach/reconnect freely; this connection remains Fabric-owned and independent.
 */
export class CaptchaGuardian implements CaptchaGuardianHandle {
  readonly #options: {
    endpoint: string;
    pollIntervalMs: number;
    solveTimeoutMs: number;
    maxRounds: number;
    connectTimeoutMs: number;
    recaptchaGraceMs: number;
  } & Pick<CaptchaGuardianOptions, "transportFactory" | "fetcher" | "models" | "tokenSolver">;
  readonly #solve: NonNullable<CaptchaGuardianOptions["solve"]>;
  readonly #logger: CaptchaGuardianLogger;
  readonly #pages = new Map<string, AttachedPage>();
  /** Frame targets the solver attaches to or holds; auto-attach cleanup must leave their sessions alone. */
  readonly #claimedFrameTargets = new Set<string>();
  /** Frame session id → its page and frame, to forget a session Chromium detached. */
  readonly #frameSessions = new Map<string, { page: AttachedPage; frameId: string }>();
  /** Serializes explicit fallback attaches and avoids duplicate page sessions. */
  readonly #attaching = new Map<string, Promise<void>>();
  #connection?: CdpConnection;
  #unsubscribe?: () => void;
  #unsubscribeClose?: () => void;
  #timer?: ReturnType<typeof setInterval>;
  #starting?: Promise<void>;
  #running = false;
  #stopRequested = false;
  #checks = 0;
  #solved = 0;
  #failed = 0;
  #lastError?: string;

  public constructor(options: CaptchaGuardianOptions) {
    if (!options.endpoint || typeof options.endpoint !== "string") throw new Error("CAPTCHA guardian endpoint is required");
    this.#options = {
      endpoint: options.endpoint,
      pollIntervalMs: numberInRange("pollIntervalMs", options.pollIntervalMs, DEFAULT_CAPTCHA_POLL_INTERVAL_MS),
      solveTimeoutMs: numberInRange("solveTimeoutMs", options.solveTimeoutMs, DEFAULT_CAPTCHA_SOLVE_TIMEOUT_MS),
      maxRounds: numberInRange("maxRounds", options.maxRounds, DEFAULT_CAPTCHA_MAX_ROUNDS),
      connectTimeoutMs: numberInRange("connectTimeoutMs", options.connectTimeoutMs, DEFAULT_CDP_CONNECT_TIMEOUT_MS),
      recaptchaGraceMs: options.recaptchaGraceMs ?? DEFAULT_RECAPTCHA_GRACE_MS,
      ...(options.transportFactory ? { transportFactory: options.transportFactory } : {}),
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(options.models?.length ? { models: options.models } : {}),
      ...(options.tokenSolver ? { tokenSolver: options.tokenSolver } : {}),
    };
    this.#solve = options.solve ?? llmCaptchaSolve;
    const logger = options.logger ?? defaultLogger;
    // Telemetry must never disrupt a protected browser session, and carries page origins only.
    this.#logger = (event, details) => {
      try {
        if (!details) return logger(event);
        const safe: Record<string, unknown> = { ...details };
        if ("url" in safe) {
          const location = safePageLocation(safe.url);
          if (location === undefined) delete safe.url;
          else safe.url = location;
        }
        logger(event, safe);
      } catch { /* telemetry is best-effort */ }
    };
  }

  public get snapshot(): CaptchaGuardianSnapshot {
    return {
      running: this.#running,
      attachedPages: this.#pages.size,
      checks: this.#checks,
      solved: this.#solved,
      failed: this.#failed,
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    };
  }

  public async start(): Promise<void> {
    if (this.#running) return;
    if (this.#starting) return this.#starting;
    this.#stopRequested = false;
    this.#lastError = undefined;
    this.#starting = this.#start().finally(() => { this.#starting = undefined; });
    return this.#starting;
  }

  async #start(): Promise<void> {
    const connection = await CdpConnection.connect({
      endpoint: this.#options.endpoint,
      timeoutMs: this.#options.connectTimeoutMs,
      ...(this.#options.transportFactory ? { transportFactory: this.#options.transportFactory } : {}),
      ...(this.#options.fetcher ? { fetcher: this.#options.fetcher } : {}),
    });
    this.#connection = connection;
    this.#unsubscribe = connection.onMessage((message) => {
      void this.#handleEvent(message).catch((error) => {
        if (!this.#stopRequested) this.#logError("target event handling failed", error, {});
      });
    });
    this.#unsubscribeClose = connection.onClose(() => this.#handleConnectionClosed(connection));

    try {
      if (this.#stopRequested) {
        connection.close();
        return;
      }
      await connection.send("Target.setDiscoverTargets", { discover: true });
      await connection.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      const targets = await connection.send("Target.getTargets");
      for (const target of (targets?.targetInfos ?? []) as Array<{ targetId?: string; type?: string; url?: string }>) {
        if (target.type === "page" && typeof target.targetId === "string") await this.#attachPage(target.targetId, target.url ?? "");
      }
      if (this.#stopRequested) {
        await this.stop();
        return;
      }
      this.#running = true;
      this.#timer = setInterval(() => this.#pollAll(), this.#options.pollIntervalMs);
      this.#pollAll();
      this.#logger("started", { pages: this.#pages.size, models: this.#options.models?.length ?? 0, tokenFallback: this.#options.tokenSolver !== undefined });
    } catch (error) {
      this.#lastError = safeErrorKind(error);
      await this.stop();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.#stopRequested = true;
    this.#teardown();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#unsubscribeClose?.();
    this.#unsubscribeClose = undefined;
    this.#attaching.clear();
    this.#connection?.close();
    this.#connection = undefined;
  }

  /** Ends all page work: solves abort, and every later command of theirs fails as stale. */
  #teardown(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#running = false;
    for (const page of this.#pages.values()) page.solving?.abort();
    this.#pages.clear();
    this.#frameSessions.clear();
    this.#claimedFrameTargets.clear();
  }

  #handleConnectionClosed(connection: CdpConnection): void {
    // Losing the process-level connection means this browser is no longer guarded. Owners use
    // snapshot.running as a fail-closed liveness signal.
    if (!this.#lastError) this.#lastError = "CAPTCHA guardian CDP connection closed";
    this.#teardown();
    if (this.#connection === connection) {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      this.#unsubscribeClose = undefined;
      this.#connection = undefined;
    }
  }

  async #handleEvent(message: Record<string, any>): Promise<void> {
    const info = message.params?.targetInfo as { targetId?: string; type?: string; url?: string } | undefined;
    switch (message.method) {
      case "Target.attachedToTarget": {
        const sessionId = typeof message.params?.sessionId === "string" ? message.params.sessionId : undefined;
        if (!sessionId) return;
        if (info?.type === "page" && info.targetId) return this.#registerPage(info.targetId, sessionId, info.url ?? "");
        // Flattened auto-attach includes workers and other auxiliary targets; retaining their sessions
        // would leak them. Frame sessions the solver attached itself stay.
        if (!(info?.targetId && this.#claimedFrameTargets.has(info.targetId))) {
          await this.#connection?.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
        }
        return;
      }
      case "Target.targetCreated":
        if (info?.type === "page" && typeof info.targetId === "string") await this.#attachPage(info.targetId, info.url ?? "");
        return;
      case "Target.targetInfoChanged": {
        const page = info?.type === "page" && typeof info.targetId === "string" ? this.#pages.get(info.targetId) : undefined;
        if (page && typeof info?.url === "string") page.url = info.url;
        return;
      }
      case "Target.detachedFromTarget": {
        const sessionId = message.params?.sessionId;
        const frame = typeof sessionId === "string" ? this.#frameSessions.get(sessionId) : undefined;
        if (frame) return this.#forgetFrameSession(sessionId, frame.page, frame.frameId);
        for (const [targetId, page] of this.#pages) {
          // A duplicate session's detach must not remove the page session retained by #registerPage,
          // so prefer the session id when CDP provides both.
          if (typeof sessionId === "string" ? page.sessionId === sessionId : targetId === message.params?.targetId) this.#removePage(targetId);
        }
        return;
      }
      case "Target.targetDestroyed":
        if (typeof message.params?.targetId === "string") this.#removePage(message.params.targetId);
        return;
      case "Page.frameNavigated": {
        const frame = message.params?.frame as { id?: string; url?: string; parentId?: string } | undefined;
        if (!frame?.url) return;
        for (const page of this.#pages.values()) {
          if (page.sessionId !== message.sessionId) continue;
          // Challenge widgets' own child-frame navigations are not a new document.
          if (frame.parentId || (page.mainFrameId && frame.id && page.mainFrameId !== frame.id)) continue;
          this.#newDocument(page, frame.url, frame.id);
        }
        return;
      }
    }
  }

  async #attachPage(targetId: string, url: string): Promise<void> {
    if (this.#pages.has(targetId) || !this.#connection || this.#stopRequested) return;
    const pending = this.#attaching.get(targetId);
    if (pending) return pending;
    const task = this.#attachPageOnce(targetId, url);
    this.#attaching.set(targetId, task);
    try { await task; } finally {
      if (this.#attaching.get(targetId) === task) this.#attaching.delete(targetId);
    }
  }

  async #attachPageOnce(targetId: string, url: string): Promise<void> {
    // Yield once so a queued auto-attach event can win before this explicit fallback request
    // creates a duplicate debugger session.
    await Promise.resolve();
    if (this.#pages.has(targetId) || !this.#connection || this.#stopRequested) return;
    try {
      const result = await this.#connection.send("Target.attachToTarget", { targetId, flatten: true });
      if (typeof result?.sessionId === "string") await this.#registerPage(targetId, result.sessionId, url);
    } catch (error) {
      if (!this.#pages.has(targetId)) this.#logError("attach page failed", error, { url });
    }
  }

  async #registerPage(targetId: string, sessionId: string, url: string): Promise<void> {
    const connection = this.#connection;
    if (!connection || this.#stopRequested) return;
    const existing = this.#pages.get(targetId);
    if (existing?.sessionId === sessionId) return;
    if (existing) {
      // Keep the first live session and close the duplicate instead of replacing it (which would
      // split navigation events and leak a session).
      await connection.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      return;
    }
    this.#pages.set(targetId, { targetId, sessionId, url, document: 0, failed: false, frames: new Map() });
    try {
      // Page events tell a new document apart. No Runtime.enable: its console bridge is a known
      // automation tell, and nothing here needs execution-context events.
      await connection.send("Page.enable", {}, sessionId);
      // The guardian is the one Fabric-owned session on every page, so it also installs the GPU
      // identity. Clients open a blank page and then navigate it, so every site document they load
      // starts with it.
      await connection.send("Page.addScriptToEvaluateOnNewDocument", { source: BROWSER_FINGERPRINT_SCRIPT }, sessionId);
      await connection.send("Runtime.evaluate", { expression: BROWSER_FINGERPRINT_SCRIPT, returnByValue: true }, sessionId);
    } catch (error) {
      this.#logError("initialize page failed", error, { url });
    }
  }

  /** A new top-level document: its solve starts over, and nothing of the old one may touch it. */
  #newDocument(page: AttachedPage, url: string, mainFrameId?: string): void {
    page.url = url;
    if (mainFrameId) page.mainFrameId = mainFrameId;
    page.document += 1;
    page.solving?.abort();
    page.solving = undefined;
    page.driver = undefined;
    page.failed = false;
    page.lastState = undefined;
    page.world = undefined;
    page.recaptchaSince = undefined;
    this.#releaseFrameSessions(page);
  }

  #removePage(targetId: string): void {
    const page = this.#pages.get(targetId);
    if (!page) return;
    this.#pages.delete(targetId);
    page.solving?.abort();
    page.solving = undefined;
    this.#releaseFrameSessions(page);
  }

  #current(page: AttachedPage, document: number): boolean {
    return this.#running && this.#pages.get(page.targetId) === page && page.document === document;
  }

  #pollAll(): void {
    if (!this.#running) return;
    for (const page of this.#pages.values()) this.#poll(page);
  }

  /** Starts a solve session on the page unless one runs or the document's session already failed. */
  #poll(page: AttachedPage): void {
    if (!this.#running || page.solving || page.failed || this.#pages.get(page.targetId) !== page) return;
    this.#checks += 1;
    const controller = new AbortController();
    page.solving = controller;
    void this.#session(page, page.document, controller)
      .catch((error) => this.#logError("solve session failed", error, { url: page.url }))
      .finally(() => { if (page.solving === controller) page.solving = undefined; });
  }

  async #session(page: AttachedPage, document: number, controller: AbortController): Promise<void> {
    const driver = page.driver ??= new GuardianDriver(this.#host(page, document));
    let modelRounds = 0;
    let result: SolveResult;
    try {
      result = await this.#solve(driver, {
        adapters: BUILTIN_ADAPTERS,
        ...(this.#options.models ? { models: this.#options.models } : {}),
        maxRounds: this.#options.maxRounds,
        timeoutMs: this.#options.solveTimeoutMs,
        signal: controller.signal,
        onRound: () => { modelRounds += 1; },
      });
    } catch (error) {
      if (controller.signal.aborted || !this.#current(page, document)) return;
      // A session that already asked the model counts as failed, so an error never becomes a paid
      // loop. One that did not (the page was between documents, say) is tried again next poll.
      if (modelRounds > 0) {
        page.failed = true;
        this.#failed += 1;
        await driver.show("failed", "error").catch(() => undefined);
        this.#logger("failed", { url: page.url, detail: "error", rounds: modelRounds, error: safeErrorKind(error) });
      } else {
        this.#logError("solve error", error, { url: page.url });
      }
      return;
    }
    if (controller.signal.aborted || !this.#current(page, document)) return;
    // A reCAPTCHA is done only once its response field holds a token, whatever llm-captcha concluded.
    const recaptcha = await this.#pendingRecaptcha(page, document);
    if (controller.signal.aborted || !this.#current(page, document)) return;
    if (recaptcha) return this.#settleRecaptcha(page, document, controller, driver, result, recaptcha);
    page.recaptchaSince = undefined;
    const previous = page.lastState;
    page.lastState = result.state;
    if (result.state === "idle") return;
    if (result.state === "solved") {
      if (previous !== "solved") this.#count("solved", page, safeDetail(result.detail), result.rounds.length);
      return;
    }
    page.failed = true;
    await driver.show("failed", result.detail).catch(() => undefined);
    this.#count("failed", page, safeDetail(result.detail), result.rounds.length, failedAdapter(result));
  }

  #count(state: "solved" | "failed", page: AttachedPage, detail: string, rounds: number, adapter?: string): void {
    if (state === "solved") this.#solved += 1;
    else this.#failed += 1;
    this.#logger(state, { url: page.url, ...(adapter ? { adapter } : {}), detail, rounds });
  }

  /**
   * A visible reCAPTCHA v2 widget still has no response after the session. A failed session (out of
   * rounds, timed out, blocked) gets the token fallback at once; after an idle one, or a `solved`
   * without a token, the widget gets a grace period (it may still be loading, or its token arriving),
   * with the page kept at `solving`. Then the document is settled: one bought token when the recipe
   * enables a provider, with the page at `solving` (`recaptcha: token fallback`) meanwhile and
   * `solved` only once that token is in, else `failed` with the reason. The page never reads
   * `failed` while the fallback is still to run.
   */
  async #settleRecaptcha(page: AttachedPage, document: number, controller: AbortController, driver: GuardianDriver, result: SolveResult, widget: PendingRecaptcha): Promise<void> {
    page.recaptchaSince ??= Date.now();
    if (result.state !== "failed" && Date.now() - page.recaptchaSince < this.#options.recaptchaGraceMs) {
      if (result.state === "solved") await driver.show("solving", "recaptcha: waiting for its response token").catch(() => undefined);
      return;
    }
    // Settled: no further session for this document, so the token is bought at most once.
    page.failed = true;
    const reason = result.state === "failed" ? safeDetail(result.detail) : result.state === "idle" ? "recaptcha: widget not reached" : "recaptcha: solved without a response token";
    const finish = async (state: "solved" | "failed", detail: string) => {
      await driver.show(state, detail).catch(() => undefined);
      this.#count(state, page, detail, result.rounds.length, state === "failed" ? failedAdapter(result) ?? "recaptcha" : undefined);
    };
    const solver = this.#options.tokenSolver;
    const contextId = solver ? await page.world : undefined;
    if (!solver || contextId === undefined) return finish("failed", reason);
    await driver.show("solving", "recaptcha: token fallback").catch(() => undefined);
    if (controller.signal.aborted || !this.#current(page, document)) return;
    this.#logger("token-fallback-started", { url: page.url, after: result.state });
    const token = await injectRecaptchaToken({ solver, send: this.#documentSession(page, document, page.sessionId).send, contextId, widget, pageUrl: page.url, signal: controller.signal });
    if (controller.signal.aborted || !this.#current(page, document)) return;
    this.#logger(`token-fallback-${token.outcome}`, { url: page.url, ...(token.outcome === "failed" ? { error: token.error } : {}) });
    if (token.outcome === "injected") await finish("solved", "recaptcha: token");
    else await finish("failed", `${reason}; token fallback ${token.error}`);
  }

  /** The visible reCAPTCHA v2 widget with an empty response the document shows, probed from the guardian's own world. */
  async #pendingRecaptcha(page: AttachedPage, document: number): Promise<PendingRecaptcha | undefined> {
    const send = this.#documentSession(page, document, page.sessionId).send;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const world = page.world ??= recaptchaWorld(send).catch(() => undefined);
      const contextId = await world;
      if (contextId === undefined) {
        if (page.world === world) page.world = undefined;
        return undefined;
      }
      try {
        return await probePendingRecaptcha(send, contextId);
      } catch {
        // The world went away with its document; make a new one once.
        if (page.world === world) page.world = undefined;
      }
    }
    return undefined;
  }

  /** The solver's view of one page document: its page session, and the frame sessions it attaches. */
  #host(page: AttachedPage, document: number): CdpHost {
    return {
      page: this.#documentSession(page, document, page.sessionId),
      frameSession: (frameId) => this.#frameSession(page, document, frameId),
    };
  }

  /** Commands for a document that navigated, closed, or whose guardian stopped never reach the browser. */
  #documentSession(page: AttachedPage, document: number, sessionId: string): CdpSession {
    return {
      send: async (method, params) => {
        const connection = this.#connection;
        if (!connection || !this.#current(page, document)) throw new StaleDocumentError();
        return connection.send(method, params ?? {}, sessionId);
      },
    };
  }

  /**
   * A session on an out-of-process frame: its target id is its frame id. Attached in flat mode on the
   * guardian's connection, cached for the document and released on navigation or page close.
   */
  async #frameSession(page: AttachedPage, document: number, frameId: string): Promise<CdpSession | undefined> {
    const connection = this.#connection;
    if (!connection || !this.#current(page, document)) return undefined;
    let attaching = page.frames.get(frameId);
    if (!attaching) {
      this.#claimedFrameTargets.add(frameId);
      attaching = connection.send("Target.attachToTarget", { targetId: frameId, flatten: true })
        .then((result) => typeof result?.sessionId === "string" ? result.sessionId as string : undefined, () => undefined);
      page.frames.set(frameId, attaching);
      const sessionId = await attaching;
      if (page.frames.get(frameId) !== attaching || !this.#current(page, document) || !sessionId) {
        // Released meanwhile, or the frame has no target of its own (it renders in its parent's process).
        if (page.frames.get(frameId) === attaching) {
          page.frames.delete(frameId);
          this.#claimedFrameTargets.delete(frameId);
        }
        if (sessionId) await connection.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
        return undefined;
      }
      this.#frameSessions.set(sessionId, { page, frameId });
      return this.#documentSession(page, document, sessionId);
    }
    const sessionId = await attaching;
    return sessionId && page.frames.get(frameId) === attaching ? this.#documentSession(page, document, sessionId) : undefined;
  }

  #forgetFrameSession(sessionId: string, page: AttachedPage, frameId: string): void {
    this.#frameSessions.delete(sessionId);
    page.frames.delete(frameId);
    this.#claimedFrameTargets.delete(frameId);
  }

  /** Detaches every frame session the page's solver held. */
  #releaseFrameSessions(page: AttachedPage): void {
    const connection = this.#connection;
    for (const [frameId, attaching] of page.frames) {
      page.frames.delete(frameId);
      void attaching.then(async (sessionId) => {
        this.#claimedFrameTargets.delete(frameId);
        if (!sessionId) return;
        this.#frameSessions.delete(sessionId);
        await connection?.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      });
    }
  }

  #logError(event: string, error: unknown, details: Record<string, unknown>): void {
    this.#lastError = safeErrorKind(error);
    this.#logger(event, { ...details, error: this.#lastError });
  }
}
