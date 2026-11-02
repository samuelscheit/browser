import { pollUntilReady, providerRequest, systemSolverClock, throwIfCanceled, type SolverClock, type SolverFetch } from "./http";
import { CaptchaSolverError, isCaptchaToken, safeProviderCode, type CaptchaTask, type TokenCaptchaSolver } from "./types";

export interface AntiCaptchaSolverOptions {
  clientKey: string;
  fetch: SolverFetch;
  clock?: SolverClock;
  endpoint?: string;
  timeoutMs?: number;
  requestTimeoutMs?: number;
}

const DEFAULT_ENDPOINT = "https://api.anti-captcha.com";
const RECAPTCHA_V2_TASK_TYPE = "RecaptchaV2TaskProxyless";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// The public documentation does not state a poll interval; use the same pacing as Death by Captcha.
const POLL_INTERVAL_MS = 3_000;

/** errorId 0 is success. Only the provider's error code is retained, never its description or the request. */
function rejectProviderError(body: Record<string, unknown>): void {
  if (typeof body.errorId === "number" && body.errorId > 0) {
    throw new CaptchaSolverError("rejected", `Anti-Captcha rejected the request (${safeProviderCode(body.errorCode)})`);
  }
}

export function createAntiCaptchaSolver(options: AntiCaptchaSolverOptions): TokenCaptchaSolver {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const clock = options.clock ?? systemSolverClock;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const post = (path: string, payload: Record<string, unknown>, signal: AbortSignal | undefined) => providerRequest(options.fetch, `${endpoint}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  }, { timeoutMs: requestTimeoutMs, signal });

  return {
    async solve(task: CaptchaTask, signal?: AbortSignal): Promise<string> {
      throwIfCanceled(signal);
      // The public documentation shows no hCaptcha task type, so this client solves only reCAPTCHA v2.
      if (task.kind !== "recaptcha-v2") throw new CaptchaSolverError("unsupported", "Anti-Captcha does not solve this widget");
      const created = await post("/createTask", {
        clientKey: options.clientKey,
        task: { type: RECAPTCHA_V2_TASK_TYPE, websiteURL: task.pageUrl, websiteKey: task.sitekey },
      }, signal);
      rejectProviderError(created);
      const taskId = created.taskId;
      if (typeof taskId !== "number" || !Number.isSafeInteger(taskId) || taskId <= 0) {
        throw new CaptchaSolverError("invalid_response", "Anti-Captcha did not return a task identifier");
      }

      return pollUntilReady({
        clock,
        timeoutMs,
        signal,
        intervalMs: () => POLL_INTERVAL_MS,
        check: async () => {
          const result = await post("/getTaskResult", { clientKey: options.clientKey, taskId }, signal);
          rejectProviderError(result);
          if (result.status !== "ready") return undefined;
          const solution = result.solution as { gRecaptchaResponse?: unknown } | undefined;
          const token = solution?.gRecaptchaResponse;
          if (!isCaptchaToken(token)) throw new CaptchaSolverError("invalid_response", "Anti-Captcha returned a malformed token");
          return token;
        },
      });
    },
  };
}
