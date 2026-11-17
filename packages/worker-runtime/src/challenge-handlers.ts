/**
 * The seam between the process-level guardian and the challenge widgets it acts on.
 *
 * The guardian owns the one browser CDP connection, page tracking, discovery of
 * visible challenge iframes, and the bounded per-challenge state. A handler owns
 * one vendor: which frame URLs belong to it (validated outside the page realm),
 * how much input it may spend, and the trusted gesture that solves its widget.
 */

/** Promise-returning CDP command sender bound to the guardian's browser connection. */
export type CdpSend = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>;

export type ChallengeKind = "turnstile" | "datadome";

/** A visible challenge iframe rectangle in top-level page coordinates (the owner's content box). */
export interface ChallengeFrameBox {
  kind: ChallengeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Internal only; telemetry sanitizes this to origin before logging. */
  frameUrl: string;
  /** CDP frame id of the iframe's document. An out-of-process frame's target id is the same id. */
  frameId?: string;
  /** Internal CDP/DOM identity used only for bounded local accounting. */
  instanceId?: string;
}

export interface ChallengeActionContext {
  readonly send: CdpSend;
  /** Session of the top-level page. Trusted input always goes here, in top-level coordinates. */
  readonly pageSessionId: string;
  /**
   * Runs `use` with a CDP session on the challenge frame's own target when it renders out of
   * process, or with `undefined` when it renders in the page's process. The session is
   * detached afterwards; the frame target's URL is revalidated before `use` runs.
   */
  withFrameSession<T>(box: ChallengeFrameBox, use: (sessionId: string | undefined) => Promise<T>): Promise<T>;
}

/**
 * - `acted`: one trusted gesture was sent; it spends one attempt.
 * - `solved`: the widget reports success; nothing to do.
 * - `waiting`: the widget is not ready (booting, resetting, out of view); retry next poll.
 * - `unsupported`: a widget variant this handler must not touch; the challenge is bounded.
 */
export type ChallengeActionOutcome = "acted" | "solved" | "waiting" | "unsupported";

export interface ChallengeBudgetPolicy {
  /** Gestures for one challenge instance. */
  maxAttempts: number;
  /** Time from detection after which the challenge is bounded. */
  timeoutMs: number;
  /** Delay from detection to the first gesture, as a person would take to see the widget. */
  firstAttemptDelayMs: number;
  /** Delay after a gesture before the next, so the vendor's verdict can arrive first. */
  retryDelayMs: number;
  /**
   * Gestures per top-level origin across all tabs and documents within a sliding window. Vendors
   * that block the IP after failures need this, since a reload starts a fresh challenge instance.
   */
  site?: { maxAttempts: number; windowMs: number };
}

export interface ChallengeHandler {
  readonly kind: ChallengeKind;
  /** Telemetry event for one gesture. */
  readonly actionEvent: string;
  readonly policy: ChallengeBudgetPolicy;
  /** Strict frame-URL check, run on CDP-reported URLs outside the page realm. */
  matchesFrameUrl(value: unknown): value is string;
  act(context: ChallengeActionContext, box: ChallengeFrameBox): Promise<ChallengeActionOutcome>;
}

/** Bounded state of one visible challenge instance on one page document. */
export interface ChallengeState {
  kind: ChallengeKind;
  startedAt: number;
  attempts: number;
  checks: number;
  nextAttemptAt: number;
  bounded: boolean;
  /** Geometry bridges DOM and frame-tree observations of the same iframe. */
  geometryKey: string;
}

export function newChallengeState(kind: ChallengeKind, policy: ChallengeBudgetPolicy, now: number, geometryKey: string): ChallengeState {
  return { kind, startedAt: now, attempts: 0, checks: 0, nextAttemptAt: now + policy.firstAttemptDelayMs, bounded: false, geometryKey };
}

/**
 * - `act`: send a gesture now.
 * - `wait`: within budget, but not yet time for the next gesture.
 * - `bound`: the budget just ran out; the caller marks the state bounded and reports it once.
 * - `bounded`: already bounded; stay silent.
 */
export type ChallengeDecision = "act" | "wait" | "bound" | "bounded";

export function challengeDecision(state: ChallengeState, policy: ChallengeBudgetPolicy, now: number, siteAttempts = 0): ChallengeDecision {
  if (state.bounded) return "bounded";
  if (now - state.startedAt > policy.timeoutMs
    || state.attempts >= policy.maxAttempts
    || (policy.site !== undefined && siteAttempts >= policy.site.maxAttempts)) return "bound";
  return now < state.nextAttemptAt ? "wait" : "act";
}

/** Gesture timestamps per site, for the sliding-window part of a budget. */
export class SiteAttemptLedger {
  readonly #attempts = new Map<string, number[]>();

  public count(site: string, windowMs: number, now: number): number {
    const recent = (this.#attempts.get(site) ?? []).filter((at) => now - at < windowMs);
    if (recent.length > 0) this.#attempts.set(site, recent);
    else this.#attempts.delete(site);
    return recent.length;
  }

  public record(site: string, now: number): void {
    this.#attempts.set(site, [...(this.#attempts.get(site) ?? []), now]);
  }
}

/** The top-level origin a site budget is keyed by; opaque documents share one key per scheme. */
export function challengeSite(kind: ChallengeKind, pageUrl: string): string {
  try {
    const parsed = new URL(pageUrl);
    return `${kind}\u0000${parsed.origin === "null" ? parsed.protocol : parsed.origin}`;
  } catch {
    return `${kind}\u0000opaque`;
  }
}

export function handlerForFrameUrl(handlers: readonly ChallengeHandler[], value: unknown): ChallengeHandler | undefined {
  return handlers.find((handler) => handler.matchesFrameUrl(value));
}
