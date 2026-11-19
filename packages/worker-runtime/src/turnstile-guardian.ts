/**
 * Process-level challenge guardian (named after Turnstile, its first handler).
 *
 * One guardian attaches to each Fabric-owned Chromium process independently of
 * application CDP clients. It observes every page/tab and performs bounded
 * trusted mouse gestures only on visible, URL-validated challenge iframes: a
 * click on the Cloudflare Turnstile checkbox while the widget shows it, and a human-like slide on
 * DataDome's slider (one handler each, see challenge-handlers.ts). Recipes whose
 * challenge handlers enable token solving also get
 * reCAPTCHA v2 token injection from this same companion (hCaptcha is unsupported).
 * The clicker itself never calls a provider API; solver traffic goes through the
 * injected TokenCaptchaSolver only.
 */
import {
  DEFAULT_TURNSTILE_CHALLENGE_TIMEOUT_MS,
  DEFAULT_TURNSTILE_MAX_CLICK_ATTEMPTS,
  DEFAULT_TURNSTILE_POLL_INTERVAL_MS,
  type TurnstileGuardianFactory,
  type TurnstileGuardianHandle,
  type TurnstileGuardianLogger,
  type TurnstileGuardianOptions,
  type TurnstileGuardianSnapshot,
  type TurnstileGuardianSpec,
  type TurnstilePageObservation,
} from "./turnstile-guardian-types";
import { BROWSER_FINGERPRINT_SCRIPT } from "./browser-fingerprint";
import type { CaptchaTask, TokenCaptchaSolver } from "./captcha-solvers/types";
import { isCaptchaSitekey, CaptchaSolverError } from "./captcha-solvers/types";
import { RECAPTCHA_V2_PROBE_SCRIPT, recaptchaCallbackScript, recaptchaFillScript } from "./captcha-solvers/recaptcha-page";
import { CdpConnection, DEFAULT_CDP_CONNECT_TIMEOUT_MS } from "./cdp-connection";
import {
  SiteAttemptLedger,
  challengeDecision,
  challengeSite,
  handlerForFrameUrl,
  newChallengeState,
  type ChallengeActionContext,
  type ChallengeFrameBox,
  type ChallengeHandler,
  type ChallengeKind,
  type ChallengeState,
} from "./challenge-handlers";
import { dataDomeSliderHandler } from "./datadome-slider";
import { turnstileClickHandler } from "./turnstile-click";
import {
  TURNSTILE_MOUSE_COMPAT_SCRIPT,
  TURNSTILE_OBSERVATION_SCRIPT,
  attributeValue,
  boxFromContentQuad,
  challengeGeometryKey,
  challengeKey,
  childFrames,
  documentIframes,
  distinctBoxes,
  isUsableBox,
  normalizeObservation,
  resolveFrameUrl,
  safeErrorKind,
  safeGuardianDetails,
  sleep,
} from "./turnstile-guardian-observation";

export {
  DEFAULT_TURNSTILE_CHALLENGE_TIMEOUT_MS,
  DEFAULT_TURNSTILE_MAX_CLICK_ATTEMPTS,
  DEFAULT_TURNSTILE_POLL_INTERVAL_MS,
} from "./turnstile-guardian-types";
export type {
  TurnstileGuardianFactory,
  TurnstileGuardianFactoryInput,
  TurnstileGuardianHandle,
  TurnstileGuardianLogger,
  TurnstileGuardianOptions,
  TurnstileGuardianSnapshot,
  TurnstileGuardianSpec,
  TurnstilePageObservation,
} from "./turnstile-guardian-types";
export {
  TURNSTILE_MOUSE_COMPAT_SCRIPT,
  TURNSTILE_OBSERVATION_SCRIPT,
} from "./turnstile-guardian-observation";

const MAX_TRACKED_CHALLENGES_PER_PAGE = 64;
const ISOLATED_WORLD_NAME = "fabric-turnstile-guardian";
/** How long a solved token waits for reCAPTCHA to create its response field. */
const FILL_FIELD_WAIT_MS = 5_000;
const FILL_FIELD_POLL_MS = 150;

type AttachedPage = {
  targetId: string;
  sessionId: string;
  url: string;
  /** Child-frame navigation must not reset the top-level document budget. */
  mainFrameId?: string;
  /** Advances on every top-level document, so token budgets are per document and never per URL. */
  documentGeneration: number;
  /**
   * Guardian-owned isolated world of the current top-level document. Cloudflare's
   * challenge watches main-world DOM queries; a widget probed from the main world
   * never leaves its "Checking your browser" stage, so page-side guardian code
   * runs only here.
   */
  isolatedContextId?: number;
  /** Bounded state is per visible widget, rather than per whole page. */
  challenges: Map<string, ChallengeState>;
};

export const defaultTurnstileGuardianSpec = (): TurnstileGuardianSpec => ({
  enabled: true,
  pollIntervalMs: DEFAULT_TURNSTILE_POLL_INTERVAL_MS,
  challengeTimeoutMs: DEFAULT_TURNSTILE_CHALLENGE_TIMEOUT_MS,
  maxClickAttempts: DEFAULT_TURNSTILE_MAX_CLICK_ATTEMPTS,
});

export const defaultTurnstileGuardianFactory: TurnstileGuardianFactory = ({ endpoint, spec, tokenSolver }) => new TurnstileGuardian({
  endpoint,
  pollIntervalMs: spec.pollIntervalMs,
  challengeTimeoutMs: spec.challengeTimeoutMs,
  maxClickAttempts: spec.maxClickAttempts,
  ...(tokenSolver ? { tokenSolver } : {}),
});

function numberInRange(value: number | undefined, fallback: number, min: number, max: number, integer = false): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Turnstile guardian value ${value} is outside ${min}..${max}`);
  if (integer && !Number.isInteger(value)) throw new Error(`Turnstile guardian value ${value} must be an integer`);
  return Math.round(value);
}

function normalizeOptions(options: TurnstileGuardianOptions): {
  endpoint: string;
  pollIntervalMs: number;
  challengeTimeoutMs: number;
  maxClickAttempts: number;
  connectTimeoutMs: number;
  transportFactory?: TurnstileGuardianOptions["transportFactory"];
  fetcher?: TurnstileGuardianOptions["fetcher"];
  logger?: TurnstileGuardianLogger;
  tokenSolver?: TokenCaptchaSolver;
} {
  if (!options.endpoint || typeof options.endpoint !== "string") throw new Error("Turnstile guardian endpoint is required");
  return {
    endpoint: options.endpoint,
    pollIntervalMs: numberInRange(options.pollIntervalMs, DEFAULT_TURNSTILE_POLL_INTERVAL_MS, 250, 30_000),
    challengeTimeoutMs: numberInRange(options.challengeTimeoutMs, DEFAULT_TURNSTILE_CHALLENGE_TIMEOUT_MS, 1_000, 120_000),
    maxClickAttempts: numberInRange(options.maxClickAttempts, DEFAULT_TURNSTILE_MAX_CLICK_ATTEMPTS, 1, 20, true),
    connectTimeoutMs: numberInRange(options.connectTimeoutMs, DEFAULT_CDP_CONNECT_TIMEOUT_MS, 500, 60_000),
    ...(options.transportFactory ? { transportFactory: options.transportFactory } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.tokenSolver ? { tokenSolver: options.tokenSolver } : {}),
  };
}

function defaultLogger(event: string, details?: Record<string, unknown>): void {
  // Callers receive only telemetry sanitized by safeGuardianDetails.
  if (details) console.info(`[fabric-guardian] ${event}`, details);
  else console.info(`[fabric-guardian] ${event}`);
}

/** Validate a guardian declaration before a runtime may launch Chromium. */
export function assertTurnstileGuardianSpec(spec: TurnstileGuardianSpec): void {
  if (!spec || spec.enabled !== true) throw new Error("Fabric browser runtimes must enable the Turnstile guardian");
  numberInRange(spec.pollIntervalMs, DEFAULT_TURNSTILE_POLL_INTERVAL_MS, 250, 30_000);
  numberInRange(spec.challengeTimeoutMs, DEFAULT_TURNSTILE_CHALLENGE_TIMEOUT_MS, 1_000, 120_000);
  numberInRange(spec.maxClickAttempts, DEFAULT_TURNSTILE_MAX_CLICK_ATTEMPTS, 1, 20, true);
}

/**
 * Parse only bounded timing knobs. There intentionally is no disable switch:
 * every Fabric CDP Chromium process carries this companion.
 */
export function turnstileGuardianSpecFromEnvironment(env: Record<string, string | undefined> = process.env): TurnstileGuardianSpec {
  const asNumber = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
    return value;
  };
  const spec = {
    enabled: true,
    pollIntervalMs: asNumber("FABRIC_TURNSTILE_POLL_INTERVAL_MS", DEFAULT_TURNSTILE_POLL_INTERVAL_MS),
    challengeTimeoutMs: asNumber("FABRIC_TURNSTILE_CHALLENGE_TIMEOUT_MS", DEFAULT_TURNSTILE_CHALLENGE_TIMEOUT_MS),
    maxClickAttempts: asNumber("FABRIC_TURNSTILE_MAX_CLICK_ATTEMPTS", DEFAULT_TURNSTILE_MAX_CLICK_ATTEMPTS),
  } satisfies TurnstileGuardianSpec;
  assertTurnstileGuardianSpec(spec);
  return spec;
}

/**
 * Watches every page target in one browser and performs bounded challenge
 * gestures. Application CDP clients may attach/reconnect freely; this
 * connection remains Fabric-owned and independent.
 */
export class TurnstileGuardian implements TurnstileGuardianHandle {
  readonly #options: ReturnType<typeof normalizeOptions>;
  readonly #logger: TurnstileGuardianLogger;
  readonly #handlers: readonly ChallengeHandler[];
  /** Gestures per vendor and top-level origin, for budgets that must survive reloads. */
  readonly #siteAttempts = new SiteAttemptLedger();
  /** Frame targets a handler is attaching to; auto-attach cleanup must leave their sessions alone. */
  readonly #claimedFrameTargets = new Set<string>();
  readonly #pages = new Map<string, AttachedPage>();
  /** Token solves in flight, keyed by page target. */
  readonly #tokenSolves = new Map<string, AbortController>();
  /** Page documents that already spent their one token solve. Navigation changes the key, so it resets. */
  readonly #attemptedTokenSolves = new Set<string>();
  /** Serializes explicit fallback attaches and avoids duplicate page sessions. */
  readonly #attaching = new Map<string, Promise<void>>();
  #connection?: CdpConnection;
  #unsubscribe?: () => void;
  #unsubscribeClose?: () => void;
  #timer?: ReturnType<typeof setInterval>;
  #starting?: Promise<void>;
  #running = false;
  #checks = 0;
  #clickAttempts = 0;
  #lastError?: string;
  #polling = false;
  #stopRequested = false;

  public constructor(options: TurnstileGuardianOptions) {
    this.#options = normalizeOptions(options);
    this.#handlers = [
      turnstileClickHandler({ maxAttempts: this.#options.maxClickAttempts, timeoutMs: this.#options.challengeTimeoutMs }),
      dataDomeSliderHandler({ timeoutMs: this.#options.challengeTimeoutMs }),
    ];
    const logger = options.logger ?? defaultLogger;
    // Telemetry must never disrupt a protected browser session.
    this.#logger = (event, details) => {
      try { logger(event, safeGuardianDetails(details)); } catch { /* telemetry is best-effort */ }
    };
  }

  public get snapshot(): TurnstileGuardianSnapshot {
    return {
      running: this.#running,
      attachedPages: this.#pages.size,
      checks: this.#checks,
      clickAttempts: this.#clickAttempts,
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
      this.#timer = setInterval(() => {
        void this.#pollAll().catch((error) => {
          if (!this.#stopRequested) this.#logError("poll loop failed", error, {});
        });
      }, this.#options.pollIntervalMs);
      await this.#pollAll();
      if (this.#stopRequested) {
        await this.stop();
        return;
      }
      this.#logger("started", { pages: this.#pages.size });
    } catch (error) {
      this.#lastError = safeErrorKind(error);
      await this.stop();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.#stopRequested = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#running = false;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#unsubscribeClose?.();
    this.#unsubscribeClose = undefined;
    this.#pages.clear();
    this.#cancelAllTokenSolves();
    this.#attaching.clear();
    this.#connection?.close();
    this.#connection = undefined;
  }

  #cancelAllTokenSolves(): void {
    for (const pending of this.#tokenSolves.values()) pending.abort();
    this.#tokenSolves.clear();
    this.#attemptedTokenSolves.clear();
  }

  #handleConnectionClosed(connection: CdpConnection): void {
    // Losing the process-level connection means this browser is no longer
    // guarded. Owners use snapshot.running as a fail-closed liveness signal.
    this.#running = false;
    if (!this.#lastError) this.#lastError = "Turnstile guardian CDP connection closed";
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#pages.clear();
    this.#cancelAllTokenSolves();
    if (this.#connection === connection) {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      this.#unsubscribeClose = undefined;
      this.#connection = undefined;
    }
  }

  async #handleEvent(message: Record<string, any>): Promise<void> {
    if (message.method === "Target.attachedToTarget") {
      const info = message.params?.targetInfo as { targetId?: string; type?: string; url?: string } | undefined;
      const sessionId = typeof message.params?.sessionId === "string" ? message.params.sessionId : undefined;
      if (!sessionId) return;
      if (info?.type === "page" && info.targetId) {
        await this.#registerPage(info.targetId, sessionId, info.url ?? "");
      } else if (!(info?.targetId && this.#claimedFrameTargets.has(info.targetId))) {
        // Flattened auto-attach includes workers/OOPIFs. The page session's
        // frame tree is enough; retaining auxiliary sessions can leak them.
        // A handler's own short-lived frame session detaches itself.
        await this.#connection?.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      }
      return;
    }
    if (message.method === "Target.targetCreated") {
      const info = message.params?.targetInfo as { targetId?: string; type?: string; url?: string } | undefined;
      if (info?.type === "page" && typeof info.targetId === "string") await this.#attachPage(info.targetId, info.url ?? "");
      return;
    }
    if (message.method === "Target.targetInfoChanged") {
      const info = message.params?.targetInfo as { targetId?: string; type?: string; url?: string } | undefined;
      if (info?.type !== "page" || typeof info.targetId !== "string") return;
      const page = this.#pages.get(info.targetId);
      if (page && typeof info.url === "string") page.url = info.url;
      return;
    }
    if (message.method === "Target.detachedFromTarget") {
      const sessionId = message.params?.sessionId;
      const targetId = message.params?.targetId;
      for (const [pageTargetId, page] of this.#pages) {
        // A duplicate session detach must not remove the page session retained
        // by #registerPage, so prefer the session id when CDP provides both.
        if (typeof sessionId === "string") {
          if (page.sessionId === sessionId) this.#removePage(pageTargetId);
        } else if (typeof targetId === "string" && pageTargetId === targetId) {
          this.#removePage(pageTargetId);
        }
      }
      return;
    }
    if (message.method === "Target.targetDestroyed") {
      const targetId = message.params?.targetId;
      if (typeof targetId === "string") this.#removePage(targetId);
      return;
    }
    if (message.method === "Page.frameNavigated") {
      const frame = message.params?.frame as { id?: string; url?: string; parentId?: string } | undefined;
      if (!frame?.url) return;
      for (const page of this.#pages.values()) {
        if (page.sessionId !== message.sessionId) continue;
        // Challenge widgets' own child-frame navigations are expected and must
        // not grant a fresh top-level budget.
        if (frame.parentId || (page.mainFrameId && frame.id && page.mainFrameId !== frame.id)) continue;
        this.#resetPageDocument(page, frame.url, frame.id);
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
    // Yield once so a queued auto-attach event can win before our explicit
    // fallback request creates a duplicate debugger session.
    await Promise.resolve();
    if (this.#pages.has(targetId) || !this.#connection || this.#stopRequested) return;
    try {
      const result = await this.#connection.send("Target.attachToTarget", { targetId, flatten: true });
      if (typeof result?.sessionId === "string") await this.#registerPage(targetId, result.sessionId, url);
    } catch (error) {
      if (!this.#pages.has(targetId)) this.#logError("attach page failed", error, { targetId, url });
    }
  }

  async #registerPage(targetId: string, sessionId: string, url: string): Promise<void> {
    if (!this.#connection || this.#stopRequested) return;
    const existing = this.#pages.get(targetId);
    if (existing?.sessionId === sessionId) return;
    if (existing) {
      // Preserve the first live session and close the duplicate instead of
      // replacing it (which would split navigation events and leak a session).
      await this.#connection.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      return;
    }
    this.#pages.set(targetId, { targetId, sessionId, url, challenges: new Map(), documentGeneration: 0 });
    try {
      await this.#connection.send("Runtime.enable", {}, sessionId);
      await this.#connection.send("Page.enable", {}, sessionId);
      await this.#connection.send("DOM.enable", {}, sessionId);
      // The guardian is the one Fabric-owned session on every page, so it also
      // installs the GPU identity. Clients open a blank page and then navigate
      // it, so every site document they load starts with these scripts.
      for (const source of [BROWSER_FINGERPRINT_SCRIPT, TURNSTILE_MOUSE_COMPAT_SCRIPT]) {
        await this.#connection.send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
        await this.#connection.send("Runtime.evaluate", { expression: source, returnByValue: true }, sessionId);
      }
    } catch (error) {
      this.#logError("initialize page failed", error, { targetId, url });
    }
  }

  #resetPageDocument(page: AttachedPage, url: string, mainFrameId?: string): void {
    // Vendors reload the page after a solve (DataDome sets its cookie, then reloads).
    this.#clearChallenges(page, "navigation");
    page.url = url;
    if (mainFrameId) page.mainFrameId = mainFrameId;
    page.isolatedContextId = undefined;
    // A new top-level document gets a fresh token budget. A solve for the previous document is cancelled
    // so its token can never be injected into this one.
    page.documentGeneration += 1;
    this.#cancelTokenSolve(page.targetId);
  }

  #cancelTokenSolve(targetId: string): void {
    const pending = this.#tokenSolves.get(targetId);
    if (!pending) return;
    this.#tokenSolves.delete(targetId);
    pending.abort();
  }

  #removePage(targetId: string): void {
    this.#cancelTokenSolve(targetId);
    const page = this.#pages.get(targetId);
    if (page) this.#attemptedTokenSolves.delete(this.#documentKey(page));
    this.#pages.delete(targetId);
  }

  /** The guardian's isolated world in the page's current top-level document. */
  async #isolatedContext(page: AttachedPage): Promise<number | undefined> {
    if (!this.#connection) return undefined;
    if (page.isolatedContextId !== undefined) return page.isolatedContextId;
    const tree = await this.#connection.send("Page.getFrameTree", {}, page.sessionId);
    const frameId = tree?.frameTree?.frame?.id;
    if (typeof frameId !== "string") return undefined;
    page.mainFrameId = frameId;
    const world = await this.#connection.send("Page.createIsolatedWorld", { frameId, worldName: ISOLATED_WORLD_NAME }, page.sessionId);
    const contextId = world?.executionContextId;
    if (typeof contextId !== "number") return undefined;
    page.isolatedContextId = contextId;
    return contextId;
  }

  async #pollAll(): Promise<void> {
    if (!this.#running || !this.#connection || this.#polling) return;
    this.#polling = true;
    try {
      // Serialize page scans to avoid burst input against multiple tabs while
      // targets are navigating.
      for (const page of [...this.#pages.values()]) {
        if (!this.#running) return;
        await this.#pollPage(page);
      }
    } finally {
      this.#polling = false;
    }
  }

  async #pollPage(page: AttachedPage): Promise<void> {
    if (!this.#connection || this.#pages.get(page.targetId) !== page) return;
    this.#checks += 1;
    let observation: TurnstilePageObservation;
    try {
      const contextId = await this.#isolatedContext(page);
      if (contextId === undefined) return;
      const result = await this.#connection.send("Runtime.evaluate", {
        expression: TURNSTILE_OBSERVATION_SCRIPT,
        contextId,
        returnByValue: true,
        awaitPromise: false,
      }, page.sessionId).catch((error: unknown) => {
        // A navigation destroys the isolated world; recreate it next poll.
        page.isolatedContextId = undefined;
        throw error;
      });
      const normalized = normalizeObservation(result?.result?.value);
      if (!normalized) return;
      observation = normalized;
    } catch (error) {
      this.#logError("page observation failed", error, { targetId: page.targetId });
      return;
    }
    // Page JavaScript supplies Turnstile signals only. Rectangles for trusted
    // input come solely from DOM.getBoxModel on CDP-reported frames.
    const frameBoxes = await this.#challengeFrameBoxes(page);
    if (this.#pages.get(page.targetId) !== page) return;

    page.url = observation.url || page.url;
    if (this.#options.tokenSolver) void this.#solveRecaptchaToken(page);

    // Revalidate the frame URL against its handler outside the page realm. A
    // hostile page cannot turn a fabricated frame into input on an arbitrary
    // cross-origin frame. A filled Turnstile response means its widget is done.
    const boxes = frameBoxes
      .filter((box) => isUsableBox(box) && this.#handler(box.kind).matchesFrameUrl(box.frameUrl) && !(box.kind === "turnstile" && observation.solved))
      .slice(0, MAX_TRACKED_CHALLENGES_PER_PAGE);
    if (boxes.length === 0) {
      // A Turnstile page whose widget is still booting keeps its budget.
      if (!observation.challenge || observation.solved) this.#clearChallenges(page, "solved");
      return;
    }

    const visibleKeys = new Set(boxes.map(challengeKey));
    for (const key of page.challenges.keys()) {
      if (visibleKeys.has(key)) continue;
      const challenge = page.challenges.get(key);
      if (!challenge || !boxes.some((box) => challengeGeometryKey(box) === challenge.geometryKey)) page.challenges.delete(key);
    }

    for (const box of boxes) {
      if (this.#pages.get(page.targetId) !== page || !this.#running) return;
      const signals = box.kind === "turnstile" ? [...new Set([...observation.signals, "challenge-frame"])] : ["challenge-frame"];
      await this.#processChallenge(page, box, signals);
    }
  }

  #handler(kind: ChallengeKind): ChallengeHandler {
    const handler = this.#handlers.find((candidate) => candidate.kind === kind);
    if (!handler) throw new Error(`No challenge handler for ${kind}`);
    return handler;
  }

  /**
   * Solves one visible reCAPTCHA v2 widget per page document through the recipe's token solver. Only the
   * sitekey, page URL, and a boolean cross the boundary, and the token is injected in the guardian's own
   * isolated world, then handed to the page's own callback in the main world.
   */
  async #solveRecaptchaToken(page: AttachedPage): Promise<void> {
    const solver = this.#options.tokenSolver;
    if (!solver || !this.#connection || this.#tokenSolves.has(page.targetId)) return;
    if (this.#attemptedTokenSolves.has(this.#documentKey(page))) return;
    const contextId = await this.#isolatedContext(page).catch(() => undefined);
    if (contextId === undefined || this.#pages.get(page.targetId) !== page) return;
    const probe = await this.#connection.send("Runtime.evaluate", {
      expression: RECAPTCHA_V2_PROBE_SCRIPT,
      contextId,
      returnByValue: true,
      awaitPromise: false,
    }, page.sessionId).then((result) => result?.result?.value as { sitekey?: unknown; callback?: unknown; solved?: unknown } | null | undefined).catch(() => undefined);
    if (!probe || probe.solved === true || !isCaptchaSitekey("recaptcha-v2", probe.sitekey)) return;
    const callback = typeof probe.callback === "string" ? probe.callback : "";
    const documentUrl = page.url;
    const controller = new AbortController();
    this.#tokenSolves.set(page.targetId, controller);
    // One paid solve per page document. A failure is final for this document: retrying on every poll
    // would spend provider credits without a new chance of success.
    this.#attemptedTokenSolves.add(this.#documentKey(page));
    this.#logger("captcha-solve-started", { url: documentUrl, kind: "recaptcha-v2" });
    try {
      const task: CaptchaTask = { kind: "recaptcha-v2", sitekey: probe.sitekey, pageUrl: documentUrl };
      const token = await solver.solve(task, controller.signal);
      if (this.#pages.get(page.targetId) !== page || controller.signal.aborted) return;
      await this.#fillResponseField(page, token, controller.signal);
      if (callback) await this.#evaluateInMainWorld(page, recaptchaCallbackScript(token, callback));
      this.#logger("captcha-solved", { url: documentUrl, kind: "recaptcha-v2" });
    } catch (error) {
      this.#logger("captcha-solve-failed", { url: documentUrl, kind: "recaptcha-v2", error: error instanceof CaptchaSolverError ? error.kind : "Error" });
    } finally {
      if (this.#tokenSolves.get(page.targetId) === controller) this.#tokenSolves.delete(page.targetId);
    }
  }

  /**
   * reCAPTCHA creates its response textarea after the widget renders, which can lag behind the probe. Retry
   * the fill briefly instead of failing on the first check; the solve itself is already paid for.
   */
  async #fillResponseField(page: AttachedPage, token: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + FILL_FIELD_WAIT_MS;
    for (;;) {
      if (signal.aborted || this.#pages.get(page.targetId) !== page) throw new CaptchaSolverError("canceled", "CAPTCHA solve was canceled");
      if (await this.#evaluateInWorld(page, recaptchaFillScript(token)) === true) return;
      if (Date.now() >= deadline) throw new CaptchaSolverError("unavailable", "reCAPTCHA response field was not present");
      await sleep(FILL_FIELD_POLL_MS);
    }
  }

  /** Identifies one top-level document. Stable while the document lives; a navigation advances it. */
  #documentKey(page: AttachedPage): string {
    return `${page.targetId}\u0000${page.documentGeneration}`;
  }

  async #evaluateInWorld(page: AttachedPage, expression: string): Promise<unknown> {
    const contextId = await this.#isolatedContext(page);
    if (contextId === undefined || !this.#connection) return undefined;
    const result = await this.#connection.send("Runtime.evaluate", { expression, contextId, returnByValue: true }, page.sessionId);
    return result?.result?.value;
  }

  async #evaluateInMainWorld(page: AttachedPage, expression: string): Promise<unknown> {
    if (!this.#connection) return undefined;
    const result = await this.#connection.send("Runtime.evaluate", { expression, returnByValue: true }, page.sessionId);
    return result?.result?.value;
  }

  /** Reports the challenges that left the page: their widget went away, or the document navigated. */
  #clearChallenges(page: AttachedPage, by: "solved" | "navigation"): void {
    if (page.challenges.size > 0) {
      let attempts = 0;
      let checks = 0;
      const kinds = new Set<ChallengeKind>();
      for (const challenge of page.challenges.values()) {
        attempts += challenge.attempts;
        checks += challenge.checks;
        kinds.add(challenge.kind);
      }
      this.#logger("cleared", { url: page.url, by, kinds: [...kinds], challenges: page.challenges.size, checks, clickAttempts: attempts });
    }
    page.challenges.clear();
  }

  async #processChallenge(page: AttachedPage, box: ChallengeFrameBox, signals: readonly string[]): Promise<void> {
    const handler = this.#handler(box.kind);
    const key = challengeKey(box);
    const geometryKey = challengeGeometryKey(box);
    let challenge = page.challenges.get(key);
    if (!challenge) {
      // A transient DOM/frame-tree race can change an internal key while the
      // physical iframe remains visible. Migrate instead of resetting budget.
      const matching = [...page.challenges.entries()].find(([, candidate]) => candidate.geometryKey === geometryKey);
      if (matching) {
        page.challenges.delete(matching[0]);
        page.challenges.set(key, matching[1]);
        challenge = matching[1];
      }
    }
    if (!challenge) {
      if (page.challenges.size >= MAX_TRACKED_CHALLENGES_PER_PAGE) return;
      challenge = newChallengeState(box.kind, handler.policy, Date.now(), geometryKey);
      page.challenges.set(key, challenge);
      this.#logger("detected", { url: page.url, kind: box.kind, signals });
    }
    challenge.geometryKey = geometryKey;
    challenge.checks += 1;
    const site = challengeSite(box.kind, page.url);
    const now = Date.now();
    const siteAttempts = handler.policy.site ? this.#siteAttempts.count(site, handler.policy.site.windowMs, now) : 0;
    const decision = challengeDecision(challenge, handler.policy, now, siteAttempts);
    if (decision === "bound") {
      challenge.bounded = true;
      this.#logger("bounded", {
        url: page.url,
        kind: box.kind,
        elapsedMs: now - challenge.startedAt,
        checks: challenge.checks,
        clickAttempts: challenge.attempts,
        siteAttempts,
        ...(challenge.widget ? { widget: challenge.widget } : {}),
      });
    }
    if (decision !== "act") return;

    let outcome;
    try {
      outcome = await handler.act(this.#actionContext(page, challenge), box);
    } catch (error) {
      this.#logError(`${box.kind} gesture failed`, error, { frameUrl: box.frameUrl });
      return;
    }
    if (outcome === "unsupported") {
      challenge.bounded = true;
      this.#logger("bounded", { url: page.url, kind: box.kind, reason: "unsupported-variant", checks: challenge.checks, clickAttempts: challenge.attempts });
      return;
    }
    if (outcome !== "acted") return;
    challenge.attempts += 1;
    challenge.nextAttemptAt = Date.now() + handler.policy.retryDelayMs;
    if (handler.policy.site) this.#siteAttempts.record(site, Date.now());
    this.#clickAttempts += 1;
    this.#logger(handler.actionEvent, { url: page.url, kind: box.kind, signals, clickAttempts: challenge.attempts });
  }

  #actionContext(page: AttachedPage, challenge: ChallengeState): ChallengeActionContext {
    const connection = this.#connection;
    if (!connection) throw new Error("Turnstile guardian is not connected");
    return {
      pageSessionId: page.sessionId,
      send: (method, params, sessionId) => connection.send(method, params ?? {}, sessionId),
      withFrameSession: (box, use) => this.#withFrameSession(connection, box, use),
      elapsedMs: Date.now() - challenge.startedAt,
      noteWidget: (state) => {
        if (challenge.widget === state) return;
        challenge.widget = state;
        this.#logger("widget", { url: page.url, kind: challenge.kind, widget: state, elapsedMs: Date.now() - challenge.startedAt, clickAttempts: challenge.attempts });
      },
    };
  }

  /**
   * An out-of-process frame is its own target whose id is the frame id. Attaching
   * fails for a frame in the page's process, which `use` then reads through the
   * page session instead. The target's CDP-reported URL is revalidated, so input
   * geometry only ever comes from the validated vendor document.
   */
  async #withFrameSession<T>(connection: CdpConnection, box: ChallengeFrameBox, use: (sessionId: string | undefined) => Promise<T>): Promise<T> {
    const frameId = box.frameId;
    if (frameId === undefined) return use(undefined);
    this.#claimedFrameTargets.add(frameId);
    let sessionId: string | undefined;
    try {
      const info = await connection.send("Target.getTargetInfo", { targetId: frameId }).catch(() => undefined);
      const target = info?.targetInfo as { type?: unknown; url?: unknown } | undefined;
      if (target?.type === "iframe") {
        if (!this.#handler(box.kind).matchesFrameUrl(target.url)) throw new Error("Challenge frame target URL changed");
        const attached = await connection.send("Target.attachToTarget", { targetId: frameId, flatten: true });
        sessionId = typeof attached?.sessionId === "string" ? attached.sessionId : undefined;
        if (!sessionId) throw new Error("Challenge frame target did not attach");
      }
      return await use(sessionId);
    } finally {
      if (sessionId) await connection.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      this.#claimedFrameTargets.delete(frameId);
    }
  }

  async #challengeFrameBoxes(page: AttachedPage): Promise<ChallengeFrameBox[]> {
    if (!this.#connection) return [];
    const boxes: ChallengeFrameBox[] = [];
    try {
      const result = await this.#connection.send("Page.getFrameTree", {}, page.sessionId);
      const rootFrame = result?.frameTree?.frame as { id?: unknown } | undefined;
      if (typeof rootFrame?.id === "string") page.mainFrameId = rootFrame.id;
      for (const frame of childFrames(result?.frameTree)) {
        const handler = handlerForFrameUrl(this.#handlers, frame.url);
        if (typeof frame.id !== "string" || !handler || typeof frame.url !== "string") continue;
        const owner = await this.#connection.send("DOM.getFrameOwner", { frameId: frame.id }, page.sessionId).catch(() => undefined);
        if (typeof owner?.backendNodeId !== "number") continue;
        const model = await this.#connection.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId }, page.sessionId).catch(() => undefined);
        const visible = await this.#isVisibleNode(page, owner.backendNodeId);
        // Older Chromium/CDP wrappers may not resolve a cross-process owner.
        // A non-empty CDP box is then the only available visibility proof.
        if (visible === false) continue;
        const box = boxFromContentQuad(model?.model?.content ?? model?.model?.border, { kind: handler.kind, frameUrl: frame.url, frameId: frame.id, instanceId: `frame:${frame.id}` });
        if (box) boxes.push(box);
      }
    } catch (error) {
      // Navigation can invalidate a tree between CDP calls. This is expected
      // during widget boot/reload, so retry next poll without turning routine
      // navigation into noisy error telemetry.
      void error;
    }

    try {
      boxes.push(...await this.#domFrameBoxes(page));
    } catch (error) {
      // Internal Chromium pages and a navigation in progress may not expose a
      // DOM root. The frame-tree path remains available; retry next poll.
      void error;
    }
    return distinctBoxes(boxes);
  }

  /**
   * Covers iframes the frame tree does not list. Cloudflare's managed challenge
   * mounts its out-of-process Turnstile iframe inside a closed shadow root,
   * which only a shadow-piercing document walk reaches.
   */
  async #domFrameBoxes(page: AttachedPage): Promise<ChallengeFrameBox[]> {
    if (!this.#connection) return [];
    const documentResult = await this.#connection.send("DOM.getDocument", { depth: -1, pierce: true }, page.sessionId);
    const iframes = documentIframes(documentResult?.root).slice(0, MAX_TRACKED_CHALLENGES_PER_PAGE);
    const boxes: ChallengeFrameBox[] = [];
    for (const node of iframes) {
      const frameUrl = resolveFrameUrl(attributeValue(node.attributes, "src"), page.url);
      const handler = handlerForFrameUrl(this.#handlers, frameUrl);
      if (!frameUrl || !handler) continue;
      const model = await this.#connection.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId }, page.sessionId).catch(() => undefined);
      const visible = await this.#isVisibleNode(page, node.backendNodeId);
      if (visible === false) continue;
      const box = boxFromContentQuad(model?.model?.content ?? model?.model?.border, {
        kind: handler.kind,
        frameUrl,
        ...(node.frameId ? { frameId: node.frameId } : {}),
        instanceId: `dom:${node.backendNodeId}`,
      });
      if (box) boxes.push(box);
    }
    return boxes;
  }

  async #isVisibleNode(page: AttachedPage, backendNodeId: number): Promise<boolean | undefined> {
    if (!this.#connection) return false;
    const sessionId = page.sessionId;
    let objectId: string | undefined;
    try {
      const executionContextId = await this.#isolatedContext(page);
      if (executionContextId === undefined) return undefined;
      const resolved = await this.#connection.send("DOM.resolveNode", { backendNodeId, executionContextId }, sessionId);
      objectId = typeof resolved?.object?.objectId === "string" ? resolved.object.objectId : undefined;
      if (!objectId) return undefined;
      const result = await this.#connection.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function () {
          const rect = this.getBoundingClientRect();
          const style = getComputedStyle(this);
          return rect.width > 0 && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden'
            && style.visibility !== 'collapse'
            && Number(style.opacity || '1') > 0
            && style.pointerEvents !== 'none'
            && rect.right > 0 && rect.bottom > 0
            && rect.left < innerWidth && rect.top < innerHeight;
        }`,
        returnByValue: true,
        silent: true,
      }, sessionId);
      if (!result?.result || !Object.prototype.hasOwnProperty.call(result.result, "value")) return undefined;
      return result.result.value === true;
    } catch (error) {
      // A detached node should retry later. Treat unsupported helper commands
      // as unavailable, allowing the already-validated non-empty CDP box.
      if (error instanceof Error && /method not found|unknown command|not supported/i.test(error.message)) return undefined;
      return false;
    } finally {
      const connection = this.#connection;
      if (objectId && connection) await connection.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => undefined);
    }
  }

  #logError(event: string, error: unknown, details: Record<string, unknown>): void {
    this.#lastError = safeErrorKind(error);
    this.#logger(event, { ...details, error: this.#lastError });
  }
}
