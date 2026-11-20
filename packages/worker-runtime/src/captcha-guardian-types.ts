/**
 * Shared contracts for the process-level CAPTCHA guardian: one Fabric-owned CDP connection per
 * browser that runs llm-captcha's solver on every page (see captcha-guardian.ts).
 */

import type { EngineOptions, solve } from "llm-captcha-solver";
import type { TokenCaptchaSolver } from "./captcha-solvers/types";
import type { CdpFetcher, CdpTransportFactory } from "./cdp-connection";

export const DEFAULT_CAPTCHA_POLL_INTERVAL_MS = 1_000;
/** One solve session, including the vendor's verdicts and every model round (llm-captcha's own default). */
export const DEFAULT_CAPTCHA_SOLVE_TIMEOUT_MS = 180_000;
/** Model rounds, slides or holds per challenge before a session gives up (llm-captcha's own default). */
export const DEFAULT_CAPTCHA_MAX_ROUNDS = 8;

export interface CaptchaGuardianSpec {
  /** Fabric-owned Chromium processes always set this to true. */
  enabled: boolean;
  /** How often each attached page without a running solve is checked for a challenge. */
  pollIntervalMs: number;
  /** Upper bound of one solve session on one page. */
  solveTimeoutMs: number;
  /** Rounds per challenge before the session fails; a failed session is final for its page document. */
  maxRounds: number;
}

/** The vision models llm-captcha asks, first to last. Empty: only challenges that need no model are solved. */
export type CaptchaModels = NonNullable<EngineOptions["models"]>;

/** llm-captcha's session entry point; tests replace it to drive the guardian's lifecycle deterministically. */
export type CaptchaSolve = typeof solve;

export type CaptchaGuardianLogger = (event: string, details?: Record<string, unknown>) => void;

export interface CaptchaGuardianOptions extends Partial<Omit<CaptchaGuardianSpec, "enabled">> {
  /** Browser websocket endpoint, or an HTTP(S) /json/version endpoint. */
  endpoint: string;
  connectTimeoutMs?: number;
  /** Test/in-process hook. Production uses the native WebSocket implementation. */
  transportFactory?: CdpTransportFactory;
  /** Test hook for resolving HTTP /json/version endpoints. */
  fetcher?: CdpFetcher;
  logger?: CaptchaGuardianLogger;
  models?: CaptchaModels;
  /**
   * reCAPTCHA v2 token provider for a visible widget whose response is still empty after a session
   * (once per page document). Absent unless the recipe enables a provider.
   */
  tokenSolver?: TokenCaptchaSolver;
  /** Grace for a widget after an idle or token-less `solved` session before it is settled. Default 5 s. */
  recaptchaGraceMs?: number;
  /** Test hook; production uses llm-captcha's `solve`. */
  solve?: CaptchaSolve;
}

export interface CaptchaGuardianSnapshot {
  running: boolean;
  attachedPages: number;
  /** Page checks: one per poll of a page without a solve in flight. */
  checks: number;
  /** Sessions that worked on a challenge and ended solved. */
  solved: number;
  /** Sessions that ended failed (each is final for its page document). */
  failed: number;
  lastError?: string;
}

/** Common lifecycle boundary for local and managed guardian owners. */
export interface CaptchaGuardianHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly snapshot: CaptchaGuardianSnapshot;
}

export interface CaptchaGuardianFactoryInput {
  endpoint: string;
  spec: CaptchaGuardianSpec;
  /** Recipe-selected reCAPTCHA v2 token provider. Undefined: llm-captcha alone. */
  tokenSolver?: TokenCaptchaSolver;
}

export type CaptchaGuardianFactory = (input: CaptchaGuardianFactoryInput) => CaptchaGuardianHandle;
