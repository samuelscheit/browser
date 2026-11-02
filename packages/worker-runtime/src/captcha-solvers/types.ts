/**
 * Provider-backed token CAPTCHA solving for Fabric browsers.
 *
 * A solver resolves a response token for a visible token CAPTCHA widget. The token is injected into the
 * page by the guardian and is never logged, stored, or returned to an application.
 */

/** Token providers a recipe may enable through an automatic handler in its challenge set. */
export const captchaSolverProviders = ["death-by-captcha", "anticaptcha"] as const;
export type CaptchaSolverProvider = (typeof captchaSolverProviders)[number];

/** Widget families the solver can satisfy. Each maps to a provider task type. */
export const captchaWidgetKinds = ["recaptcha-v2", "hcaptcha"] as const;
export type CaptchaWidgetKind = (typeof captchaWidgetKinds)[number];

/** A visible token CAPTCHA widget that is waiting for a response token. */
export interface CaptchaTask {
  kind: CaptchaWidgetKind;
  /** Public widget key. It is not a credential, but it is not logged either. */
  sitekey: string;
  /** Top-level document the widget is served on. */
  pageUrl: string;
}

export interface TokenCaptchaSolver {
  /** Resolves a response token, or rejects with a CaptchaSolverError whose kind is safe to log. */
  solve(task: CaptchaTask, signal?: AbortSignal): Promise<string>;
}

export type CaptchaSolverFailureKind = "unsupported" | "unavailable" | "rejected" | "timeout" | "canceled" | "transport" | "invalid_response";

/** Carries only a stable failure class. Provider bodies, keys, and tokens never enter the message. */
export class CaptchaSolverError extends Error {
  public readonly kind: CaptchaSolverFailureKind;

  public constructor(kind: CaptchaSolverFailureKind, message: string) {
    super(message);
    this.name = "CaptchaSolverError";
    this.kind = kind;
  }
}

const sitekeyPattern = /^[A-Za-z0-9_-]{16,80}$/;
const hcaptchaSitekeyPattern = /^[A-Za-z0-9-]{16,80}$/;
// Printable ASCII only: the token is embedded in page script as a JSON string literal.
const tokenPattern = /^[\x21-\x7e]{20,8192}$/;

export function isCaptchaSitekey(kind: CaptchaWidgetKind, value: unknown): value is string {
  if (typeof value !== "string") return false;
  return kind === "hcaptcha" ? hcaptchaSitekeyPattern.test(value) : sitekeyPattern.test(value);
}

export function isCaptchaToken(value: unknown): value is string {
  return typeof value === "string" && tokenPattern.test(value);
}

/** Provider error codes are echoed only when they look like codes; anything else becomes "unknown". */
export function safeProviderCode(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : "unknown";
}
