import { LlmError } from "./types";

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetch?: Fetcher;
  /** Attempts in total, including the first. */
  attempts?: number;
  /** Backoff before retry `n` (1-based) without a Retry-After header. */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Timeout of one HTTP attempt. */
  requestTimeoutMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const MAX_RETRY_AFTER_MS = 60_000;

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after-ms") ?? undefined;
  if (header && Number.isFinite(Number(header))) return Math.min(Number(header), MAX_RETRY_AFTER_MS);
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.min(Math.max(0, seconds * 1_000), MAX_RETRY_AFTER_MS);
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? undefined : Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
}

/** Pull a readable message out of an API error body without dumping the whole response. */
function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
    if (typeof message === "string") return message.slice(0, 500);
  } catch { /* not JSON */ }
  return body.slice(0, 500);
}

/**
 * POST JSON with retries on rate limits, overload and transient network errors. Honors
 * Retry-After, and the caller's abort signal between and during attempts.
 */
export async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal | undefined, options: HttpOptions = {}): Promise<unknown> {
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  const attempts = options.attempts ?? 4;
  const backoff = options.backoffMs ?? ((attempt) => Math.min(30_000, 1_000 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5));
  const sleep = options.sleep ?? abortableSleep;
  const payload = JSON.stringify(body);
  let lastError: LlmError | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw signal.reason;
    let waitMs: number | undefined;
    try {
      const attemptSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(options.requestTimeoutMs ?? 180_000)]);
      const response = await fetcher(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload, signal: attemptSignal });
      const text = await response.text();
      if (response.ok) {
        try {
          return JSON.parse(text);
        } catch {
          throw new LlmError(`${url} returned invalid JSON: ${text.slice(0, 200)}`, response.status);
        }
      }
      const retryable = RETRYABLE_STATUS.has(response.status);
      lastError = new LlmError(`HTTP ${response.status}: ${errorDetail(text)}`, response.status, retryable);
      if (!retryable) throw lastError;
      waitMs = retryAfterMs(response);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof LlmError) {
        if (!error.retryable) throw error;
        lastError = error;
      } else {
        // Network failure or a per-attempt timeout: transient.
        lastError = new LlmError(`request failed: ${error instanceof Error ? error.message : String(error)}`, undefined, true);
      }
    }
    if (attempt < attempts) await sleep(waitMs ?? backoff(attempt), signal);
  }
  throw lastError ?? new LlmError("request failed");
}
