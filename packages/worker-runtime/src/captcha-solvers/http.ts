import { CaptchaSolverError, type CaptchaSolverFailureKind } from "./types";

/** Injectable transport. Production routes solver traffic through the Fabric egress sidecar. */
export type SolverFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface SolverClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export const systemSolverClock: SolverClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/**
 * Provider traffic leaves through the reviewed Fabric egress sidecar, which admits only the provider
 * hostnames on its solver listener. A solver therefore cannot become a general direct-egress path.
 */
export function proxiedSolverFetch(proxyUrl: string): SolverFetch {
  return (input, init) => fetch(input, { ...init, proxy: proxyUrl } as RequestInit);
}

export function throwIfCanceled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CaptchaSolverError("canceled", "CAPTCHA solve was canceled");
}

function requestFailure(
  callerSignal: AbortSignal | undefined,
  deadline: AbortSignal,
  fallback: CaptchaSolverFailureKind,
  message: string,
): CaptchaSolverError {
  if (callerSignal?.aborted) return new CaptchaSolverError("canceled", "CAPTCHA solve was canceled");
  if (deadline.aborted) return new CaptchaSolverError("timeout", "CAPTCHA provider request timed out");
  return new CaptchaSolverError(fallback, message);
}

/**
 * One bounded provider request. Only the HTTP class and response shape are reported; request bodies,
 * credentials, and response bodies never reach an error message.
 */
export async function providerRequest(
  fetcher: SolverFetch,
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  throwIfCanceled(options.signal);
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal });
  } catch {
    throw requestFailure(options.signal, deadline, "transport", "CAPTCHA provider request failed");
  }
  if (!response.ok) throw new CaptchaSolverError("transport", `CAPTCHA provider returned HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw requestFailure(options.signal, deadline, "invalid_response", "CAPTCHA provider returned malformed JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CaptchaSolverError("invalid_response", "CAPTCHA provider returned an unexpected body");
  }
  return body as Record<string, unknown>;
}

/** Polls until the provider reports a value, bounded by one overall deadline. */
export async function pollUntilReady<T>(options: {
  clock: SolverClock;
  timeoutMs: number;
  signal?: AbortSignal;
  intervalMs: (attempt: number) => number;
  check: () => Promise<T | undefined>;
}): Promise<T> {
  const deadline = options.clock.now() + options.timeoutMs;
  for (let attempt = 0; ; attempt += 1) {
    throwIfCanceled(options.signal);
    const value = await options.check();
    if (value !== undefined) return value;
    const remaining = deadline - options.clock.now();
    if (remaining <= 0) throw new CaptchaSolverError("timeout", "CAPTCHA solve timed out");
    await options.clock.sleep(Math.min(Math.max(1, options.intervalMs(attempt)), remaining));
  }
}
