import { describe, expect, test } from "bun:test";
import {
  CaptchaSolverError,
  createAntiCaptchaSolver,
  createDeathByCaptchaSolver,
  createTokenSolver,
  automaticCaptchaSolverProviders,
  isCaptchaSitekey,
  isCaptchaToken,
  safeProviderCode,
  type CaptchaTask,
  type SolverClock,
  type SolverFetch,
  type TokenCaptchaSolver,
} from "@browser-fabric/worker-runtime";
import { recaptchaCallbackScript, recaptchaFillScript, RECAPTCHA_V2_PROBE_SCRIPT } from "../packages/worker-runtime/src/captcha-solvers/recaptcha-fallback";
import type { ChallengeHandler } from "@browser-fabric/contracts";

const SITEKEY = "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI";
const PAGE = "https://site.example.test/form";
const TOKEN = "03AFcWeA".padEnd(64, "x");
const task: CaptchaTask = { sitekey: SITEKEY, pageUrl: PAGE };

/** Deterministic clock: sleeps advance time instantly and are recorded. */
function fakeClock(): SolverClock & { sleeps: number[] } {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
  };
}

/** Scripted provider: replays responses in order and records every request body it received. */
function scriptedProvider(responses: Array<Record<string, unknown> | ((url: string, init?: RequestInit) => Response)>) {
  const requests: Array<{ url: string; body: unknown }> = [];
  const fetch: SolverFetch = async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    requests.push({ url, body });
    const next = responses.shift();
    if (next === undefined) throw new Error("scripted provider ran out of responses");
    if (typeof next === "function") return next(url, init);
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, requests };
}

describe("recipe-gated solver selection", () => {
  const handler = (kind: ChallengeHandler["kind"], mode: ChallengeHandler["mode"]): ChallengeHandler => ({ id: `${kind}-${mode}`, kind, mode, configuration: {} });

  test("enables only automatic DBC and AntiCaptcha handlers, in recipe order", () => {
    expect(automaticCaptchaSolverProviders([
      handler("anticaptcha", "automatic"),
      handler("guardian", "automatic"),
      handler("dbc", "automatic"),
    ])).toEqual(["anticaptcha", "death-by-captcha"]);
  });

  test("never enables a token solver for manual or fallback handlers", () => {
    expect(automaticCaptchaSolverProviders([
      handler("dbc", "manual"),
      handler("anticaptcha", "fallback"),
      handler("manual-handoff", "manual"),
      handler("guardian", "automatic"),
    ])).toEqual([]);
  });

  test("a recipe without any challenge handler set gets no solver", () => {
    expect(automaticCaptchaSolverProviders(undefined)).toEqual([]);
    expect(createTokenSolver([], {})).toBeUndefined();
  });

  test("a provider the recipe enables but that has no credentials yields no solver", () => {
    expect(createTokenSolver(["death-by-captcha"], {})).toBeUndefined();
  });

  test("de-duplicates a provider listed by two handlers", () => {
    expect(automaticCaptchaSolverProviders([handler("dbc", "automatic"), handler("dbc", "automatic")])).toEqual(["death-by-captcha"]);
  });
});

describe("provider failover", () => {
  test("uses the first provider that yields a token", async () => {
    const first: TokenCaptchaSolver = { solve: async () => { throw new CaptchaSolverError("rejected", "bad"); } };
    const second: TokenCaptchaSolver = { solve: async () => TOKEN };
    const solver = createTokenSolver(["death-by-captcha", "anticaptcha"], { "death-by-captcha": first, anticaptcha: second });
    await expect(solver!.solve(task)).resolves.toBe(TOKEN);
  });

  test("a canceled solve is not retried through a second, paid provider", async () => {
    let secondCalls = 0;
    const first: TokenCaptchaSolver = { solve: async () => { throw new CaptchaSolverError("canceled", "canceled"); } };
    const second: TokenCaptchaSolver = { solve: async () => { secondCalls += 1; return TOKEN; } };
    const solver = createTokenSolver(["death-by-captcha", "anticaptcha"], { "death-by-captcha": first, anticaptcha: second });
    await expect(solver!.solve(task)).rejects.toMatchObject({ kind: "canceled" });
    expect(secondCalls).toBe(0);
  });

  test("reports the last failure class when every provider fails", async () => {
    const failing: TokenCaptchaSolver = { solve: async () => { throw new CaptchaSolverError("timeout", "slow"); } };
    const solver = createTokenSolver(["death-by-captcha"], { "death-by-captcha": failing });
    await expect(solver!.solve(task)).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("Death by Captcha client", () => {
  test("submits reCAPTCHA v2 as token type 4 with googlekey and pageurl, then polls the solved text", async () => {
    const provider = scriptedProvider([
      { captcha: 9001, status: 0 },
      { captcha: 9001, text: "", is_correct: false },
      { captcha: 9001, text: TOKEN, is_correct: true },
    ]);
    const solver = createDeathByCaptchaSolver({ credentials: { username: "user-1", password: "pass-1" }, fetch: provider.fetch, clock: fakeClock() });
    await expect(solver.solve(task)).resolves.toBe(TOKEN);

    const [create] = provider.requests;
    expect(create!.url).toBe("https://api.dbcapi.me/api/captcha");
    expect(create!.body).toBeInstanceOf(FormData);
    const form = create!.body as FormData;
    expect(form.get("type")).toBe("4");
    expect(form.get("username")).toBe("user-1");
    expect(JSON.parse(String(form.get("token_params")))).toEqual({ googlekey: SITEKEY, pageurl: PAGE });
    expect(provider.requests[1]!.url).toBe("https://api.dbcapi.me/api/captcha/9001");
  });

  test("never returns a solved token whose is_correct flag is false", async () => {
    const provider = scriptedProvider([
      { captcha: 9002 },
      { captcha: 9002, text: TOKEN, is_correct: false },
    ]);
    const solver = createDeathByCaptchaSolver({ credentials: { username: "u", password: "p" }, fetch: provider.fetch, clock: fakeClock() });
    await expect(solver.solve(task)).rejects.toMatchObject({ kind: "rejected" });
  });

  test("rejects a provider refusal without echoing its message", async () => {
    const provider = scriptedProvider([{ error: "Access denied: secret-balance-detail" }]);
    const solver = createDeathByCaptchaSolver({ credentials: { username: "u", password: "p" }, fetch: provider.fetch, clock: fakeClock() });
    const failure = await solver.solve(task).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "rejected" });
    expect(String((failure as Error).message)).not.toContain("secret-balance-detail");
  });

  test("times out when the provider never reports a solution, within the overall deadline", async () => {
    const pending = { captcha: 9003, text: "" };
    const provider = scriptedProvider([{ captcha: 9003 }, pending, pending, pending, pending, pending, pending, pending, pending, pending]);
    const clock = fakeClock();
    const solver = createDeathByCaptchaSolver({ credentials: { username: "u", password: "p" }, fetch: provider.fetch, clock, timeoutMs: 10_000 });
    await expect(solver.solve(task)).rejects.toMatchObject({ kind: "timeout" });
    expect(clock.now()).toBeLessThanOrEqual(10_000);
  });
});

describe("AntiCaptcha client", () => {
  test("creates a RecaptchaV2TaskProxyless task and reads the gRecaptchaResponse solution", async () => {
    const provider = scriptedProvider([
      { errorId: 0, taskId: 7654321 },
      { errorId: 0, status: "processing" },
      { errorId: 0, status: "ready", solution: { gRecaptchaResponse: TOKEN } },
    ]);
    const solver = createAntiCaptchaSolver({ clientKey: "client-key-1", fetch: provider.fetch, clock: fakeClock() });
    await expect(solver.solve(task)).resolves.toBe(TOKEN);

    expect(provider.requests[0]!.url).toBe("https://api.anti-captcha.com/createTask");
    expect(provider.requests[0]!.body).toEqual({
      clientKey: "client-key-1",
      task: { type: "RecaptchaV2TaskProxyless", websiteURL: PAGE, websiteKey: SITEKEY },
    });
    expect(provider.requests[1]!.body).toEqual({ clientKey: "client-key-1", taskId: 7654321 });
  });

  test("an error response surfaces only the provider error code, not its description", async () => {
    const provider = scriptedProvider([{ errorId: 1, errorCode: "ERROR_ZERO_BALANCE", errorDescription: "balance is 0.00 for account 123" }]);
    const solver = createAntiCaptchaSolver({ clientKey: "k", fetch: provider.fetch, clock: fakeClock() });
    const failure = await solver.solve(task).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "rejected" });
    expect(String((failure as Error).message)).toContain("ERROR_ZERO_BALANCE");
    expect(String((failure as Error).message)).not.toContain("123");
  });

  test("rejects a malformed solution token instead of injecting it", async () => {
    const provider = scriptedProvider([
      { errorId: 0, taskId: 5 },
      { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "bad token with spaces" } },
    ]);
    const solver = createAntiCaptchaSolver({ clientKey: "k", fetch: provider.fetch, clock: fakeClock() });
    await expect(solver.solve(task)).rejects.toMatchObject({ kind: "invalid_response" });
  });
});

describe("transport and cancellation", () => {
  test("a transport failure never leaks the request URL or body", async () => {
    const fetch: SolverFetch = async () => { throw new Error(`socket failed for ${PAGE} with key client-key-1`); };
    const solver = createAntiCaptchaSolver({ clientKey: "client-key-1", fetch, clock: fakeClock() });
    const failure = await solver.solve(task).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "transport" });
    expect(String((failure as Error).message)).not.toContain("client-key-1");
    expect(String((failure as Error).message)).not.toContain(PAGE);
  });

  test("a non-JSON provider body is an invalid response, not a crash", async () => {
    const fetch: SolverFetch = async () => new Response("<html>gateway</html>", { status: 200 });
    const solver = createDeathByCaptchaSolver({ credentials: { username: "u", password: "p" }, fetch, clock: fakeClock() });
    await expect(solver.solve(task)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  test("an aborted caller signal stops a solve before the provider is contacted", async () => {
    const provider = scriptedProvider([]);
    const controller = new AbortController();
    controller.abort();
    const solver = createAntiCaptchaSolver({ clientKey: "k", fetch: provider.fetch, clock: fakeClock() });
    await expect(solver.solve(task, controller.signal)).rejects.toMatchObject({ kind: "canceled" });
    expect(provider.requests).toHaveLength(0);
  });
});

describe("input validation", () => {
  test("accepts a real reCAPTCHA sitekey and rejects anything else", () => {
    expect(isCaptchaSitekey(SITEKEY)).toBe(true);
    expect(isCaptchaSitekey("short")).toBe(false);
    expect(isCaptchaSitekey("has spaces in it at all")).toBe(false);
    expect(isCaptchaSitekey(undefined)).toBe(false);
  });

  test("accepts a token of printable ASCII only", () => {
    expect(isCaptchaToken(TOKEN)).toBe(true);
    expect(isCaptchaToken("token with a space inside it here")).toBe(false);
    expect(isCaptchaToken(`${TOKEN}\n`)).toBe(false);
    expect(isCaptchaToken("\"}); alert(1); //" + "x".repeat(40))).toBe(false);
  });

  test("keeps only code-shaped provider error codes", () => {
    expect(safeProviderCode("ERROR_ZERO_BALANCE")).toBe("ERROR_ZERO_BALANCE");
    expect(safeProviderCode("<script>")).toBe("unknown");
    expect(safeProviderCode(42)).toBe("unknown");
  });
});

describe("page-side scripts", () => {
  test("the probe finds widgets by their anchor frame and returns only a sitekey", () => {
    expect(RECAPTCHA_V2_PROBE_SCRIPT).toContain('iframe[src*="/recaptcha/api2/anchor"]');
    // The probe must never return the response value itself.
    expect(RECAPTCHA_V2_PROBE_SCRIPT).not.toMatch(/return\s+[^;]*\.value\b/);
    expect(RECAPTCHA_V2_PROBE_SCRIPT).toContain("return { sitekey };");
  });

  test("a token is embedded as a JSON string literal, so page script cannot break out", () => {
    const hostile = `"); window.__pwned = 1; ("`;
    const fill = recaptchaFillScript(hostile);
    expect(fill).toContain(JSON.stringify(hostile));
    expect(fill).not.toContain(`const token = "); window.__pwned`);
  });

  test("the callback script carries the token and sitekey as JSON literals and looks names up on window only", () => {
    const hostile = `"); window.__pwned = 1; ("`;
    const script = recaptchaCallbackScript(hostile, hostile);
    expect(script).toContain(`const token = ${JSON.stringify(hostile)};`);
    expect(script).toContain(`const sitekey = ${JSON.stringify(hostile)};`);
    expect(script).not.toContain("eval(");
    expect(script).toContain("typeof window[callback] === 'function'");
  });
});
