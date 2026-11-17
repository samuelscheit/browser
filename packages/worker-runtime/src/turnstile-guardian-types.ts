/**
 * Shared contracts for the process-level challenge guardian. It is named after Turnstile, its
 * first handler; it also slides DataDome's slider (see challenge-handlers.ts).
 */

import type { TokenCaptchaSolver } from "./captcha-solvers/types";
import type { CdpFetcher, CdpTransportFactory } from "./cdp-connection";

export const DEFAULT_TURNSTILE_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_TURNSTILE_CHALLENGE_TIMEOUT_MS = 12_000;
export const DEFAULT_TURNSTILE_MAX_CLICK_ATTEMPTS = 5;

export interface TurnstileGuardianSpec {
  /** Fabric-owned Chromium processes always set this to true. */
  enabled: boolean;
  /** How often each attached page is inspected. */
  pollIntervalMs: number;
  /** Maximum time spent on one challenge before it is bounded. */
  challengeTimeoutMs: number;
  /** Maximum Turnstile click gestures for one challenge instance. DataDome has its own fixed, smaller budget. */
  maxClickAttempts: number;
}

export type TurnstileGuardianLogger = (event: string, details?: Record<string, unknown>) => void;
export interface TurnstileGuardianOptions extends Partial<Omit<TurnstileGuardianSpec, "enabled">> {
  /** Browser websocket endpoint, or an HTTP(S) /json/version endpoint. */
  endpoint: string;
  connectTimeoutMs?: number;
  /** Test/in-process hook. Production uses the native WebSocket implementation. */
  transportFactory?: CdpTransportFactory;
  /** Test hook for resolving HTTP /json/version endpoints. */
  fetcher?: CdpFetcher;
  logger?: TurnstileGuardianLogger;
  /** Token solver for visible reCAPTCHA v2 widgets. Absent unless the recipe enables a provider. */
  tokenSolver?: TokenCaptchaSolver;
}

/** Scalar Turnstile signals from the page's isolated world. Geometry never comes from the page. */
export interface TurnstilePageObservation {
  url: string;
  title: string;
  signals: string[];
  challenge: boolean;
  solved: boolean;
}

export interface TurnstileGuardianSnapshot {
  running: boolean;
  attachedPages: number;
  checks: number;
  /** Trusted gestures sent across all handlers: Turnstile clicks and DataDome slides. */
  clickAttempts: number;
  lastError?: string;
}

/** Common lifecycle boundary for local and managed guardian owners. */
export interface TurnstileGuardianHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly snapshot: TurnstileGuardianSnapshot;
}

export interface TurnstileGuardianFactoryInput {
  endpoint: string;
  spec: TurnstileGuardianSpec;
  /** Recipe-selected solver. Undefined means the guardian only clicks Turnstile, as before. */
  tokenSolver?: TokenCaptchaSolver;
}

export type TurnstileGuardianFactory = (input: TurnstileGuardianFactoryInput) => TurnstileGuardianHandle;
