/**
 * Process-level Cloudflare Turnstile guardian.
 *
 * One guardian attaches to each Fabric-owned Chromium process independently of
 * application CDP clients. It observes every page/tab and performs a bounded,
 * Media-style trusted mouse gesture only on visible Cloudflare Turnstile
 * iframe owners. It is intentionally not a token solver or a general CAPTCHA
 * clicker: it never calls a provider API, writes forms, or exports token data.
 */
import {
  DEFAULT_TURNSTILE_CHALLENGE_TIMEOUT_MS,
  DEFAULT_TURNSTILE_CONNECT_TIMEOUT_MS,
  DEFAULT_TURNSTILE_MAX_CLICK_ATTEMPTS,
  DEFAULT_TURNSTILE_POLL_INTERVAL_MS,
  type TurnstileChallengeBox,
  type TurnstileGuardianFactory,
  type TurnstileGuardianHandle,
  type TurnstileGuardianLogger,
  type TurnstileGuardianOptions,
  type TurnstileGuardianSnapshot,
  type TurnstileGuardianSpec,
  type TurnstilePageObservation,
} from "./turnstile-guardian-types";
import { CdpConnection } from "./turnstile-guardian-cdp";
import {
  TURNSTILE_MOUSE_COMPAT_SCRIPT,
  TURNSTILE_OBSERVATION_SCRIPT,
  attributeValue,
  boxFromContentQuad,
  childFrames,
  distinctBoxes,
  isTurnstileFrameUrl,
  isUsableBox,
  jitter,
  normalizeObservation,
  resolveTurnstileFrameUrl,
  safeErrorKind,
  safeGuardianDetails,
  sleep,
  turnstileChallengeKey,
  turnstileGeometryKey,
} from "./turnstile-guardian-observation";

export {
  DEFAULT_TURNSTILE_CHALLENGE_TIMEOUT_MS,
  DEFAULT_TURNSTILE_CONNECT_TIMEOUT_MS,
  DEFAULT_TURNSTILE_MAX_CLICK_ATTEMPTS,
  DEFAULT_TURNSTILE_POLL_INTERVAL_MS,
} from "./turnstile-guardian-types";
export type {
  CdpTransport,
  TurnstileChallengeBox,
  TurnstileGuardianFactory,
  TurnstileGuardianFactoryInput,
  TurnstileGuardianFetcher,
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
export { resolveTurnstileGuardianWebSocketEndpoint } from "./turnstile-guardian-cdp";

const MAX_TRACKED_CHALLENGES_PER_PAGE = 64;

type ActiveTurnstileChallenge = {
  startedAt: number;
  clickAttempts: number;
  checks: number;
  cooldownUntil: number;
  /** Geometry bridges DOM and frame-tree observations of the same iframe. */
  geometryKey: string;
};

type AttachedPage = {
  targetId: string;
  sessionId: string;
  url: string;
  /** Child-frame navigation must not reset the top-level document budget. */
  mainFrameId?: string;
  /** Bounded state is per visible widget, rather than per whole page. */
  challenges: Map<string, ActiveTurnstileChallenge>;
};

export const defaultTurnstileGuardianSpec = (): TurnstileGuardianSpec => ({
  enabled: true,
  pollIntervalMs: DEFAULT_TURNSTILE_POLL_INTERVAL_MS,
  challengeTimeoutMs: DEFAULT_TURNSTILE_CHALLENGE_TIMEOUT_MS,
  maxClickAttempts: DEFAULT_TURNSTILE_MAX_CLICK_ATTEMPTS,
});

export const defaultTurnstileGuardianFactory: TurnstileGuardianFactory = ({ endpoint, spec }) => new TurnstileGuardian({
  endpoint,
  pollIntervalMs: spec.pollIntervalMs,
  challengeTimeoutMs: spec.challengeTimeoutMs,
  maxClickAttempts: spec.maxClickAttempts,
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
} {
  if (!options.endpoint || typeof options.endpoint !== "string") throw new Error("Turnstile guardian endpoint is required");
  return {
    endpoint: options.endpoint,
    pollIntervalMs: numberInRange(options.pollIntervalMs, DEFAULT_TURNSTILE_POLL_INTERVAL_MS, 250, 30_000),
    challengeTimeoutMs: numberInRange(options.challengeTimeoutMs, DEFAULT_TURNSTILE_CHALLENGE_TIMEOUT_MS, 1_000, 120_000),
    maxClickAttempts: numberInRange(options.maxClickAttempts, DEFAULT_TURNSTILE_MAX_CLICK_ATTEMPTS, 1, 20, true),
    connectTimeoutMs: numberInRange(options.connectTimeoutMs, DEFAULT_TURNSTILE_CONNECT_TIMEOUT_MS, 500, 60_000),
    ...(options.transportFactory ? { transportFactory: options.transportFactory } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  };
}

function defaultLogger(event: string, details?: Record<string, unknown>): void {
  // Callers receive only telemetry sanitized by safeGuardianDetails.
  if (details) console.info(`[fabric-turnstile] ${event}`, details);
  else console.info(`[fabric-turnstile] ${event}`);
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
 * Watches every page target in one browser and performs bounded Turnstile
 * checkbox gestures. Application CDP clients may attach/reconnect freely;
 * this connection remains Fabric-owned and independent.
 */
export class TurnstileGuardian implements TurnstileGuardianHandle {
  readonly #options: ReturnType<typeof normalizeOptions>;
  readonly #logger: TurnstileGuardianLogger;
  readonly #pages = new Map<string, AttachedPage>();
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
    this.#attaching.clear();
    this.#connection?.close();
    this.#connection = undefined;
  }

  #handleConnectionClosed(connection: CdpConnection): void {
    // Losing the process-level connection means this browser is no longer
    // guarded. Owners use snapshot.running as a fail-closed liveness signal.
    this.#running = false;
    if (!this.#lastError) this.#lastError = "Turnstile guardian CDP connection closed";
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#pages.clear();
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
      } else {
        // Flattened auto-attach includes workers/OOPIFs. The page session's
        // frame tree is enough; retaining auxiliary sessions can leak them.
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
          if (page.sessionId === sessionId) this.#pages.delete(pageTargetId);
        } else if (typeof targetId === "string" && pageTargetId === targetId) {
          this.#pages.delete(pageTargetId);
        }
      }
      return;
    }
    if (message.method === "Target.targetDestroyed") {
      const targetId = message.params?.targetId;
      if (typeof targetId === "string") this.#pages.delete(targetId);
      return;
    }
    if (message.method === "Page.frameNavigated") {
      const frame = message.params?.frame as { id?: string; url?: string; parentId?: string } | undefined;
      if (!frame?.url) return;
      for (const page of this.#pages.values()) {
        if (page.sessionId !== message.sessionId) continue;
        // Turnstile's own child-frame navigations are expected and must not
        // grant a fresh top-level click budget.
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
    this.#pages.set(targetId, { targetId, sessionId, url, challenges: new Map() });
    try {
      await this.#connection.send("Runtime.enable", {}, sessionId);
      await this.#connection.send("Page.enable", {}, sessionId);
      await this.#connection.send("DOM.enable", {}, sessionId);
      await this.#connection.send("Page.addScriptToEvaluateOnNewDocument", { source: TURNSTILE_MOUSE_COMPAT_SCRIPT }, sessionId);
      await this.#connection.send("Runtime.evaluate", { expression: TURNSTILE_MOUSE_COMPAT_SCRIPT, returnByValue: true }, sessionId);
    } catch (error) {
      this.#logError("initialize page failed", error, { targetId, url });
    }
  }

  #resetPageDocument(page: AttachedPage, url: string, mainFrameId?: string): void {
    page.url = url;
    if (mainFrameId) page.mainFrameId = mainFrameId;
    page.challenges.clear();
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
      const result = await this.#connection.send("Runtime.evaluate", {
        expression: TURNSTILE_OBSERVATION_SCRIPT,
        returnByValue: true,
        awaitPromise: false,
      }, page.sessionId);
      const normalized = normalizeObservation(result?.result?.value);
      if (!normalized) return;
      // Page JavaScript supplies signals only. Never trust a page-returned
      // geometry value for trusted CDP input; rectangles below come solely
      // from DOM.getBoxModel / Page.getFrameTree.
      observation = { ...normalized, boxes: [] };
      const frameBoxes = await this.#turnstileFrameBoxes(page);
      if (this.#pages.get(page.targetId) !== page) return;
      if (frameBoxes.length > 0) {
        observation = {
          ...observation,
          challenge: !observation.solved,
          signals: [...new Set([...observation.signals, "challenge-frame"])],
          // CDP frame-tree boxes carry a stable frame identity and are first so
          // dedupe preserves them over ordinary DOM-query observations.
          boxes: distinctBoxes([...frameBoxes, ...observation.boxes]),
        };
      }
    } catch (error) {
      this.#logError("page observation failed", error, { targetId: page.targetId });
      return;
    }

    page.url = observation.url || page.url;
    if (!observation.challenge || observation.solved) {
      this.#clearChallenges(page);
      return;
    }

    // Revalidate origin outside the page realm. A hostile page cannot turn a
    // fabricated observation into a click on an arbitrary cross-origin frame.
    const boxes = distinctBoxes(observation.boxes.filter((box) => isUsableBox(box) && isTurnstileFrameUrl(box.frameUrl)))
      .slice(0, MAX_TRACKED_CHALLENGES_PER_PAGE);
    if (boxes.length === 0) return;

    const visibleKeys = new Set(boxes.map(turnstileChallengeKey));
    for (const key of page.challenges.keys()) {
      if (visibleKeys.has(key)) continue;
      const challenge = page.challenges.get(key);
      if (!challenge || !boxes.some((box) => turnstileGeometryKey(box) === challenge.geometryKey)) page.challenges.delete(key);
    }

    for (const box of boxes) {
      if (this.#pages.get(page.targetId) !== page || !this.#running) return;
      await this.#processChallenge(page, box, observation.signals);
    }
  }

  #clearChallenges(page: AttachedPage): void {
    if (page.challenges.size > 0) {
      let clickAttempts = 0;
      let checks = 0;
      for (const challenge of page.challenges.values()) {
        clickAttempts += challenge.clickAttempts;
        checks += challenge.checks;
      }
      this.#logger("cleared", { url: page.url, challenges: page.challenges.size, checks, clickAttempts });
    }
    page.challenges.clear();
  }

  async #processChallenge(page: AttachedPage, box: TurnstileChallengeBox, signals: readonly string[]): Promise<void> {
    const key = turnstileChallengeKey(box);
    const geometryKey = turnstileGeometryKey(box);
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
      challenge = { startedAt: Date.now(), clickAttempts: 0, checks: 0, cooldownUntil: 0, geometryKey };
      page.challenges.set(key, challenge);
      this.#logger("detected", { url: page.url, signals });
    }
    challenge.geometryKey = geometryKey;
    challenge.checks += 1;
    const elapsed = Date.now() - challenge.startedAt;
    if (Date.now() < challenge.cooldownUntil || elapsed > this.#options.challengeTimeoutMs || challenge.clickAttempts >= this.#options.maxClickAttempts) {
      if (challenge.cooldownUntil === 0) {
        challenge.cooldownUntil = Date.now() + Math.max(this.#options.challengeTimeoutMs, 5_000);
        this.#logger("bounded", { url: page.url, elapsedMs: elapsed, checks: challenge.checks, clickAttempts: challenge.clickAttempts });
      }
      return;
    }
    if (await this.#click(page.sessionId, box)) {
      challenge.clickAttempts += 1;
      this.#clickAttempts += 1;
      this.#logger("clicked", { url: page.url, signals, clickAttempts: challenge.clickAttempts });
    }
  }

  async #turnstileFrameBoxes(page: AttachedPage): Promise<TurnstileChallengeBox[]> {
    if (!this.#connection) return [];
    const boxes: TurnstileChallengeBox[] = [];
    try {
      const result = await this.#connection.send("Page.getFrameTree", {}, page.sessionId);
      const rootFrame = result?.frameTree?.frame as { id?: unknown } | undefined;
      if (typeof rootFrame?.id === "string") page.mainFrameId = rootFrame.id;
      for (const frame of childFrames(result?.frameTree)) {
        if (typeof frame.id !== "string" || !isTurnstileFrameUrl(frame.url)) continue;
        const owner = await this.#connection.send("DOM.getFrameOwner", { frameId: frame.id }, page.sessionId).catch(() => undefined);
        if (typeof owner?.backendNodeId !== "number") continue;
        const model = await this.#connection.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId }, page.sessionId).catch(() => undefined);
        const visible = await this.#isVisibleNode(page.sessionId, { backendNodeId: owner.backendNodeId });
        // Older Chromium/CDP wrappers may not resolve a cross-process owner.
        // A non-empty CDP box is then the only available visibility proof.
        if (visible === false) continue;
        const box = boxFromContentQuad(model?.model?.content ?? model?.model?.border, frame.url, `frame:${frame.id}`);
        if (box) boxes.push(box);
      }
    } catch (error) {
      // Navigation can invalidate a tree between CDP calls. This is expected
      // during widget boot/reload, so retry next poll without turning routine
      // navigation into noisy error telemetry.
      void error;
    }

    try {
      boxes.push(...await this.#turnstileDomFrameBoxes(page));
    } catch (error) {
      // Internal Chromium pages and a navigation in progress may not expose a
      // DOM root. The frame-tree path remains available; retry next poll.
      void error;
    }
    return distinctBoxes(boxes);
  }

  /** Covers normal same-process iframes before they appear in Page.getFrameTree. */
  async #turnstileDomFrameBoxes(page: AttachedPage): Promise<TurnstileChallengeBox[]> {
    if (!this.#connection) return [];
    const documentResult = await this.#connection.send("DOM.getDocument", { depth: 1, pierce: false }, page.sessionId);
    const rootNodeId = documentResult?.root?.nodeId;
    if (typeof rootNodeId !== "number") return [];
    const query = await this.#connection.send("DOM.querySelectorAll", { nodeId: rootNodeId, selector: "iframe" }, page.sessionId);
    const nodeIds = Array.isArray(query?.nodeIds)
      ? query.nodeIds.filter((nodeId: unknown): nodeId is number => Number.isInteger(nodeId)).slice(0, MAX_TRACKED_CHALLENGES_PER_PAGE)
      : [];
    const boxes: TurnstileChallengeBox[] = [];
    for (const nodeId of nodeIds) {
      const described = await this.#connection.send("DOM.describeNode", { nodeId, depth: 0 }, page.sessionId).catch(() => undefined);
      const node = described?.node as { attributes?: unknown; backendNodeId?: unknown } | undefined;
      const frameUrl = resolveTurnstileFrameUrl(attributeValue(node?.attributes, "src"), page.url);
      if (!frameUrl) continue;
      const model = await this.#connection.send("DOM.getBoxModel", { nodeId }, page.sessionId).catch(() => undefined);
      const visible = await this.#isVisibleNode(page.sessionId, {
        nodeId,
        ...(typeof node?.backendNodeId === "number" ? { backendNodeId: node.backendNodeId } : {}),
      });
      if (visible === false) continue;
      const box = boxFromContentQuad(model?.model?.content ?? model?.model?.border, frameUrl, `dom:${nodeId}`);
      if (box) boxes.push(box);
    }
    return boxes;
  }

  async #isVisibleNode(sessionId: string, node: { nodeId?: number; backendNodeId?: number }): Promise<boolean | undefined> {
    if (!this.#connection) return false;
    let objectId: string | undefined;
    try {
      const resolveParams = node.backendNodeId !== undefined
        ? { backendNodeId: node.backendNodeId }
        : node.nodeId !== undefined
          ? { nodeId: node.nodeId }
          : {};
      if (Object.keys(resolveParams).length === 0) return undefined;
      const resolved = await this.#connection.send("DOM.resolveNode", resolveParams, sessionId);
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

  async #click(sessionId: string, box: TurnstileChallengeBox): Promise<boolean> {
    if (!this.#connection) return false;
    const x = Math.max(1, box.x + Math.min(Math.max(2, box.width / 2), Math.max(2, Math.min(30, box.width - 2))));
    const y = Math.max(1, box.y + Math.min(Math.max(2, box.height / 2), Math.max(2, box.height - 2)));
    try {
      // Mirror the former Media page.mouse.move(..., {steps}) gesture: a
      // short eased approach, then one press/release at a stable click point.
      const startX = Math.max(1, x - 70 - Math.random() * 35);
      const startY = Math.max(1, y - 25 - Math.random() * 25);
      const steps = 12;
      for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps;
        const eased = progress * progress * (3 - 2 * progress);
        await this.#connection.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: jitter(startX + (x - startX) * eased),
          y: jitter(startY + (y - startY) * eased),
          button: "none",
          timestamp: Date.now() / 1_000,
        }, sessionId);
        if (step < steps) await sleep(12);
      }
      await sleep(40);
      const clickX = jitter(x, 1);
      const clickY = jitter(y, 1);
      await this.#connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: clickX, y: clickY, button: "left", buttons: 1, clickCount: 1, timestamp: Date.now() / 1_000 }, sessionId);
      await sleep(55);
      await this.#connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: clickX, y: clickY, button: "left", buttons: 0, clickCount: 1, timestamp: Date.now() / 1_000 }, sessionId);
      return true;
    } catch (error) {
      this.#logError("click failed", error, { sessionId, frameUrl: box.frameUrl });
      return false;
    }
  }

  #logError(event: string, error: unknown, details: Record<string, unknown>): void {
    this.#lastError = safeErrorKind(error);
    this.#logger(event, { ...details, error: this.#lastError });
  }
}
