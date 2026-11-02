import { pollUntilReady, providerRequest, systemSolverClock, throwIfCanceled, type SolverClock, type SolverFetch } from "./http";
import { CaptchaSolverError, isCaptchaToken, type CaptchaTask, type TokenCaptchaSolver } from "./types";

export interface DeathByCaptchaCredentials {
  username: string;
  password: string;
}

export interface DeathByCaptchaSolverOptions {
  credentials: DeathByCaptchaCredentials;
  fetch: SolverFetch;
  clock?: SolverClock;
  endpoint?: string;
  /** Overall deadline for one token, including polling. */
  timeoutMs?: number;
  requestTimeoutMs?: number;
}

const DEFAULT_ENDPOINT = "https://api.dbcapi.me/api";
// The OpenAPI spec's token type for a reCAPTCHA v2 token, with parameters in token_params.
const RECAPTCHA_V2_TOKEN_TYPE = "4";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// The provider asks clients not to poll more often than every couple of seconds.
const POLL_INTERVAL_MS = 3_000;

function rejectProviderError(body: Record<string, unknown>): void {
  // The provider reports refusals (credentials, balance, service state) as an error string.
  const error = typeof body.error === "string" ? body.error.trim() : "";
  if (error) throw new CaptchaSolverError("rejected", "Death by Captcha rejected the request");
}

function captchaId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  return undefined;
}

export function createDeathByCaptchaSolver(options: DeathByCaptchaSolverOptions): TokenCaptchaSolver {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const clock = options.clock ?? systemSolverClock;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return {
    async solve(task: CaptchaTask, signal?: AbortSignal): Promise<string> {
      throwIfCanceled(signal);
      // The public documentation gives no hCaptcha token type, so this client solves only reCAPTCHA v2.
      if (task.kind !== "recaptcha-v2") throw new CaptchaSolverError("unsupported", "Death by Captcha does not solve this widget");
      const form = new FormData();
      form.set("username", options.credentials.username);
      form.set("password", options.credentials.password);
      form.set("type", RECAPTCHA_V2_TOKEN_TYPE);
      form.set("token_params", JSON.stringify({ googlekey: task.sitekey, pageurl: task.pageUrl }));
      // Do not set Content-Type here: FormData supplies the multipart boundary.
      const created = await providerRequest(options.fetch, `${endpoint}/captcha`, {
        method: "POST",
        body: form,
        headers: { Accept: "application/json" },
      }, { timeoutMs: requestTimeoutMs, signal });
      rejectProviderError(created);
      const id = captchaId(created.captcha);
      if (!id) throw new CaptchaSolverError("rejected", "Death by Captcha did not accept the task");

      return pollUntilReady({
        clock,
        timeoutMs,
        signal,
        intervalMs: () => POLL_INTERVAL_MS,
        check: async () => {
          const status = await providerRequest(options.fetch, `${endpoint}/captcha/${encodeURIComponent(id)}`, {
            headers: { Accept: "application/json" },
          }, { timeoutMs: requestTimeoutMs, signal });
          rejectProviderError(status);
          const text = typeof status.text === "string" ? status.text.trim() : "";
          if (!text) return undefined;
          // The adapters in the app use the solved text only when is_correct is true.
          if (status.is_correct !== true) throw new CaptchaSolverError("rejected", "Death by Captcha rejected the solved token");
          if (!isCaptchaToken(text)) throw new CaptchaSolverError("invalid_response", "Death by Captcha returned a malformed token");
          return text;
        },
      });
    },
  };
}
