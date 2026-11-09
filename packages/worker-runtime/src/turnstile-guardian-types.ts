/** Shared contracts for the process-level Cloudflare Turnstile guardian. */

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
  /** Maximum time spent clicking one challenge before entering cooldown. */
  challengeTimeoutMs: number;
  /** Maximum click gestures issued for one challenge instance. */
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

/** A visible Turnstile iframe rectangle in top-level page coordinates. */
export interface TurnstileChallengeBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Internal only; telemetry sanitizes this to origin before logging. */
  frameUrl: string;
  /** Internal CDP/DOM identity used only for bounded local accounting. */
  instanceId?: string;
}

export interface TurnstilePageObservation {
  url: string;
  title: string;
  signals: string[];
  challenge: boolean;
  solved: boolean;
  boxes: TurnstileChallengeBox[];
}

export interface TurnstileGuardianSnapshot {
  running: boolean;
  attachedPages: number;
  checks: number;
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
