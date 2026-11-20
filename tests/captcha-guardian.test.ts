import { describe, expect, test } from "bun:test";
import {
  BROWSER_FINGERPRINT_SCRIPT,
  BUILTIN_ADAPTERS,
  CaptchaGuardian,
  ChromiumProcessSupervisor,
  RECAPTCHA_V2_PROBE_SCRIPT,
  WEBGL_RENDERER,
  WEBGL_VENDOR,
  captchaGuardianSpecFromEnvironment,
  defaultCaptchaGuardianSpec,
  resolveBrowserWebSocketEndpoint,
  type BrowserContainerSpec,
  type CaptchaGuardianHandle,
  type CaptchaTask,
  type TokenCaptchaSolver,
} from "@browser-fabric/worker-runtime";
import puppeteer, { type Browser as PuppeteerBrowser } from "puppeteer-core";
import { FakeCdpTransport, ScriptedSolve, eventually, fakeGuardianOptions, sleep, type Command, type GuardianLog, type SolveCall } from "./support/fake-guardian-transport";

type SolveCallFinish = SolveCall["finish"];
import { browserIntegration, requireChromium } from "./support/chromium";

class FakeChromiumProcess {
  public readonly pid = 4242;
  /** What ended the process: a signal name, or "closed" when Chromium exited after Browser.close. */
  public exitedBy?: string;
  #listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  #exited = false;

  public once(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  /** Chromium exiting by itself, as it does after a CDP Browser.close. */
  public exit(): void {
    if (this.#exited) return;
    this.#exited = true;
    this.exitedBy = "closed";
    for (const listener of this.#listeners.get("exit") ?? []) listener();
  }

  public kill(signal: string = "SIGTERM"): boolean {
    if (this.#exited) return false;
    this.#exited = true;
    this.exitedBy = signal;
    for (const listener of this.#listeners.get("exit") ?? []) listener();
    return true;
  }
}

class FakeGuardian implements CaptchaGuardianHandle {
  public starts = 0;
  public stops = 0;
  public running = true;

  public get snapshot() {
    return { running: this.running, attachedPages: 0, checks: 0, solved: 0, failed: 0 };
  }

  public async start(): Promise<void> { this.starts += 1; }
  public async stop(): Promise<void> { this.stops += 1; this.running = false; }
}

/** A guardian on a fake browser with scripted llm-captcha sessions. */
async function startGuardian(transport = new FakeCdpTransport(), extra: { tokenSolver?: TokenCaptchaSolver } = {}) {
  const scripted = new ScriptedSolve();
  const logs: GuardianLog[] = [];
  const guardian = new CaptchaGuardian({ ...fakeGuardianOptions(transport, scripted, logs), ...extra });
  await guardian.start();
  return { guardian, transport, scripted, logs };
}

/** The CDP host the guardian handed llm-captcha's driver for one page document. */
function hostOf(driver: unknown): { page: { send(method: string, params?: Record<string, unknown>): Promise<any> }; frameSession(frameId: string): Promise<{ send(method: string, params?: Record<string, unknown>): Promise<any> } | undefined> } {
  return (driver as { host: ReturnType<typeof hostOf> }).host;
}

const POLLS = 4 * 250;

describe("CAPTCHA guardian sessions", () => {
  test("runs one llm-captcha session per page at a time, with the built-in adapters and its bounds", async () => {
    const transport = new FakeCdpTransport();
    const scripted = new ScriptedSolve();
    const guardian = new CaptchaGuardian({ ...fakeGuardianOptions(transport, scripted), solveTimeoutMs: 60_000, maxRounds: 3 });
    await guardian.start();
    await eventually(() => scripted.calls.length === 1);
    // Many polls pass while the session runs; none starts a second one.
    await sleep(POLLS);
    expect(scripted.calls).toHaveLength(1);
    const { options } = scripted.calls[0]!;
    expect(options.adapters).toBe(BUILTIN_ADAPTERS);
    expect(options).toMatchObject({ timeoutMs: 60_000, maxRounds: 3 });
    // No key configured: no models, so only model-free challenges are solved. Nobody answers
    // llm-captcha's assist panel in a Fabric browser, so its driver has no assist mode.
    expect(options.models).toBeUndefined();
    expect((scripted.calls[0]!.driver as { ask?: unknown }).ask).toBeUndefined();
    expect(options.signal?.aborted).toBe(false);
    await guardian.stop();
  });

  test("keeps watching after idle and solved sessions, with one driver per document, and reports a solve once", async () => {
    const { guardian, scripted, logs } = await startGuardian();
    await eventually(() => scripted.calls.length === 1);
    scripted.calls[0]!.finish({ state: "idle", detail: "no challenge found" });
    await eventually(() => scripted.calls.length === 2);
    scripted.calls[1]!.finish({ state: "solved", detail: "challenge gone" });
    await eventually(() => scripted.calls.length === 3);
    // A later step of the same page can show a new challenge, so a solved page stays watched.
    scripted.calls[2]!.finish({ state: "solved", detail: "no challenge left" });
    await eventually(() => scripted.calls.length === 4);
    // The isolated worlds the driver injected stay cached for the document.
    expect(new Set(scripted.calls.map((call) => call.driver)).size).toBe(1);
    expect(logs.filter(({ event }) => event === "solved")).toHaveLength(1);
    expect(guardian.snapshot).toMatchObject({ solved: 1, failed: 0, running: true, attachedPages: 1 });
    await guardian.stop();
  });

  test("a failed session is final for its document: no new session until the top-level document navigates", async () => {
    const { guardian, transport, scripted, logs } = await startGuardian();
    await eventually(() => scripted.calls.length === 1);
    scripted.calls[0]!.finish({ state: "failed", detail: "recaptcha-images: not solved in 8 rounds" });
    await sleep(POLLS);
    expect(scripted.calls).toHaveLength(1);
    // A challenge widget's own frame navigating is no new document.
    transport.emitEvent("Page.frameNavigated", { frame: { id: "widget", parentId: "top", url: "https://www.google.com/recaptcha/api2/bframe" } }, "page-session-1");
    await sleep(POLLS);
    expect(scripted.calls).toHaveLength(1);
    transport.navigate("page-session-1", "https://example.test/next");
    await eventually(() => scripted.calls.length === 2);
    expect(scripted.calls[1]!.driver).not.toBe(scripted.calls[0]!.driver);
    expect(guardian.snapshot.failed).toBe(1);
    expect(logs.find(({ event }) => event === "failed")?.details).toEqual({
      url: "https://example.test",
      adapter: "recaptcha-images",
      detail: "recaptcha-images: not solved in 8 rounds",
      rounds: 0,
    });
    await guardian.stop();
  });

  test("an error after model rounds ends the document's attempts; one before any model round is retried", async () => {
    const { guardian, scripted, logs } = await startGuardian();
    await eventually(() => scripted.calls.length === 1);
    scripted.calls[0]!.fail(new Error("Page.getLayoutMetrics: target closed"));
    // Nothing was paid for: the next poll tries again.
    await eventually(() => scripted.calls.length === 2);
    scripted.calls[1]!.options.onRound?.({} as never);
    scripted.calls[1]!.fail(new Error("model gateway unreachable"));
    await sleep(POLLS);
    expect(scripted.calls).toHaveLength(2);
    expect(guardian.snapshot.failed).toBe(1);
    expect(logs.find(({ event }) => event === "failed")?.details).toMatchObject({ detail: "error", rounds: 1, error: "Error" });
    await guardian.stop();
  });

  test("a top-level navigation aborts the running session, and its driver can no longer send input to the page", async () => {
    const { guardian, transport, scripted } = await startGuardian();
    await eventually(() => scripted.calls.length === 1);
    const first = scripted.calls[0]!;
    transport.navigate("page-session-1", "https://example.test/after");
    expect(first.options.signal?.aborted).toBe(true);
    // A gesture of the aborted session that was still underway stops at its next event.
    await expect(hostOf(first.driver).page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 })).rejects.toThrow(/document is gone/);
    expect(transport.sent("Input.dispatchMouseEvent")).toHaveLength(0);
    await eventually(() => scripted.calls.length === 2);
    await guardian.stop();
  });

  test("pages are independent: closing one aborts only its session, and nothing reaches the closed page", async () => {
    const transport = new FakeCdpTransport({ pages: [{ targetId: "page-1", url: "https://a.test/" }, { targetId: "page-2", url: "https://b.test/" }] });
    const { guardian, scripted } = await startGuardian(transport);
    await eventually(() => scripted.calls.length === 2);
    // Pages are polled in attach order: the first session is page-1's.
    const [one, two] = scripted.calls;
    transport.emitEvent("Target.targetDestroyed", { targetId: "page-1" });
    expect(one!.options.signal?.aborted).toBe(true);
    expect(two!.options.signal?.aborted).toBe(false);
    await expect(hostOf(one!.driver).page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 })).rejects.toThrow(/document is gone/);
    await hostOf(two!.driver).page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
    expect(transport.sent("Input.dispatchMouseEvent").map((command) => command.sessionId)).toEqual(["page-session-2"]);
    expect(guardian.snapshot.attachedPages).toBe(1);
    await guardian.stop();
  });

  test("stop aborts every session and fails liveness", async () => {
    const { guardian, scripted } = await startGuardian();
    await eventually(() => scripted.calls.length === 1);
    await guardian.stop();
    expect(scripted.calls[0]!.options.signal?.aborted).toBe(true);
    expect(guardian.snapshot).toMatchObject({ running: false, attachedPages: 0 });
  });

  test("fails its health snapshot closed when the guardian CDP channel disappears", async () => {
    const { guardian, transport, scripted } = await startGuardian();
    await eventually(() => scripted.calls.length === 1);
    transport.close();
    await sleep(0);
    expect(scripted.calls[0]!.options.signal?.aborted).toBe(true);
    expect(guardian.snapshot).toMatchObject({ running: false, attachedPages: 0, lastError: "CAPTCHA guardian CDP connection closed" });
    await guardian.stop();
  });
});

describe("CAPTCHA guardian frame sessions", () => {
  test("attaches an out-of-process frame in flat mode once, keeps it through auto-attach cleanup, and releases it on navigation", async () => {
    const transport = new FakeCdpTransport({ frameTargets: ["turnstile-frame"] });
    const { guardian, scripted } = await startGuardian(transport);
    await eventually(() => scripted.calls.length === 1);
    const host = hostOf(scripted.calls[0]!.driver);
    const [frame, again] = await Promise.all([host.frameSession("turnstile-frame"), host.frameSession("turnstile-frame")]);
    expect(frame).toBeDefined();
    expect(again).toBeDefined();
    expect(transport.sent("Target.attachToTarget").filter((command) => command.params?.targetId === "turnstile-frame")).toEqual([
      expect.objectContaining({ params: { targetId: "turnstile-frame", flatten: true } }),
    ]);
    await frame!.send("DOM.getDocument", { depth: -1, pierce: true });
    expect(transport.sent("DOM.getDocument").map((command) => command.sessionId)).toEqual(["frame-session:turnstile-frame"]);
    // The attach event of the solver's own frame session is not an auxiliary session to drop.
    await sleep(10);
    expect(transport.sent("Target.detachFromTarget")).toHaveLength(0);

    transport.navigate("page-session-1", "https://example.test/next");
    await eventually(() => transport.sent("Target.detachFromTarget").some((command) => command.params?.sessionId === "frame-session:turnstile-frame"));
    // The old document's frame session is gone for good.
    await expect(frame!.send("DOM.getDocument")).rejects.toThrow(/document is gone/);
    expect(await host.frameSession("turnstile-frame")).toBeUndefined();
    await guardian.stop();
  });

  test("forgets a frame session Chromium detached, and attaches afresh next time", async () => {
    const transport = new FakeCdpTransport({ frameTargets: ["frame-a"] });
    const { guardian, scripted } = await startGuardian(transport);
    await eventually(() => scripted.calls.length === 1);
    const host = hostOf(scripted.calls[0]!.driver);
    await host.frameSession("frame-a");
    transport.emitEvent("Target.detachedFromTarget", { sessionId: "frame-session:frame-a", targetId: "frame-a" });
    await sleep(0);
    expect(guardian.snapshot.attachedPages).toBe(1);
    await host.frameSession("frame-a");
    expect(transport.sent("Target.attachToTarget").filter((command) => command.params?.targetId === "frame-a")).toHaveLength(2);
    await guardian.stop();
  });

  test("a frame without its own target yields no session", async () => {
    const { guardian, scripted } = await startGuardian();
    await eventually(() => scripted.calls.length === 1);
    expect(await hostOf(scripted.calls[0]!.driver).frameSession("in-process-frame")).toBeUndefined();
    await guardian.stop();
  });

  test("detaches auxiliary auto-attached targets it did not ask for", async () => {
    const { guardian, transport } = await startGuardian();
    transport.emitEvent("Target.attachedToTarget", { sessionId: "worker-session", targetInfo: { targetId: "service-worker", type: "service_worker", url: "https://example.test/sw.js" } });
    transport.emitEvent("Target.attachedToTarget", { sessionId: "oopif-session", targetInfo: { targetId: "frame-target", type: "iframe", url: "https://challenges.cloudflare.com/x" } });
    await sleep(10);
    expect(transport.sent("Target.detachFromTarget").map((command) => command.params?.sessionId).sort()).toEqual(["oopif-session", "worker-session"]);
    expect(guardian.snapshot.attachedPages).toBe(1);
    await guardian.stop();
  });
});

describe("CAPTCHA guardian pages", () => {
  test("installs the GPU identity on every page it attaches, without enabling the Runtime domain", async () => {
    const { guardian, transport } = await startGuardian();
    transport.emitEvent("Target.attachedToTarget", { sessionId: "new-page-session", targetInfo: { targetId: "page-2", type: "page", url: "about:blank" } });
    await sleep(10);
    for (const sessionId of ["page-session-1", "new-page-session"]) {
      expect(transport.sent("Page.addScriptToEvaluateOnNewDocument", sessionId).map((command) => command.params?.source)).toEqual([BROWSER_FINGERPRINT_SCRIPT]);
      // The page's current document gets the identity too.
      expect(transport.sent("Runtime.evaluate", sessionId).some((command) => command.params?.expression === BROWSER_FINGERPRINT_SCRIPT)).toBe(true);
    }
    // Runtime.enable is a well-known automation tell; nothing in the guardian needs it.
    expect(transport.sent("Runtime.enable")).toHaveLength(0);
    await guardian.stop();
  });

  test("keeps the first page CDP session when auto-attach races its explicit attach fallback", async () => {
    const { guardian, transport } = await startGuardian();
    transport.emitEvent("Target.attachedToTarget", { sessionId: "duplicate-page-session", targetInfo: { targetId: "page-1", type: "page", url: "https://example.test/protected" } });
    await sleep(0);
    expect(guardian.snapshot.attachedPages).toBe(1);
    expect(transport.sent("Target.detachFromTarget").some((command) => command.params?.sessionId === "duplicate-page-session")).toBe(true);
    await guardian.stop();
  });

  test("logs page origins only, never paths, queries, or solver internals", async () => {
    const { guardian, scripted, logs } = await startGuardian();
    await eventually(() => scripted.calls.length === 1);
    scripted.calls[0]!.finish({ state: "failed", detail: "turnstile: blocked <script>", snapshot: { adapter: "turnstile", html: "<div>secret page</div>" } });
    await eventually(() => logs.some(({ event }) => event === "failed"));
    const text = JSON.stringify(logs);
    expect(text).not.toContain("protected");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("<script>");
    await guardian.stop();
  });
});

describe("CAPTCHA guardian reCAPTCHA token fallback", () => {
  const SITEKEY = "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI";
  const TOKEN = `03AFcWeA${"x".repeat(56)}`;
  const GRACE_MS = 600;

  /** A page whose top document may show a reCAPTCHA widget, as the probe in the guardian's world reads it. */
  function recaptchaPage(widget: { shown: boolean; solved: boolean } = { shown: true, solved: false }): FakeCdpTransport {
    return new FakeCdpTransport({
      respond: (command: Command) => {
        if (command.method === "Page.createIsolatedWorld") return { executionContextId: 9 };
        if (command.method !== "Runtime.evaluate" || command.params?.contextId !== 9) return undefined;
        const expression = String(command.params.expression);
        if (expression === RECAPTCHA_V2_PROBE_SCRIPT) return { result: { value: widget.shown ? { sitekey: SITEKEY, callback: "onOk", solved: widget.solved } : null } };
        // The fill script: the token is in the response field from now on.
        widget.solved = true;
        return { result: { value: true } };
      },
    });
  }

  function recordingSolver() {
    const tasks: CaptchaTask[] = [];
    return { tasks, solver: { solve: async (task: CaptchaTask) => { tasks.push(task); return TOKEN; } } satisfies TokenCaptchaSolver };
  }

  /** A guardian whose sessions all end like `result`, recording what the page is told. */
  async function guardedPage(transport: FakeCdpTransport, tokenSolver?: TokenCaptchaSolver) {
    const scripted = new ScriptedSolve();
    const logs: GuardianLog[] = [];
    const published: Array<[string, string]> = [];
    const guardian = new CaptchaGuardian({ ...fakeGuardianOptions(transport, scripted, logs), recaptchaGraceMs: GRACE_MS, ...(tokenSolver ? { tokenSolver } : {}) });
    await guardian.start();
    await eventually(() => scripted.calls.length === 1);
    // The page bundle is not in a fake browser; record what the guardian publishes through the driver.
    (scripted.calls[0]!.driver as { publish(state: string, detail: string): Promise<void> }).publish = async (state, detail) => { published.push([state, detail]); };
    return { guardian, scripted, logs, published };
  }

  /** Ends every session the guardian starts, as `result`, until the test stops. */
  function endEverySession(scripted: ScriptedSolve, result: Parameters<SolveCallFinish>[0]): () => void {
    let stopped = false;
    void (async () => {
      let handled = 0;
      while (!stopped) {
        while (handled < scripted.calls.length) scripted.calls[handled++]!.finish(result);
        await sleep(10);
      }
    })();
    return () => { stopped = true; };
  }

  test("trigger 1: a failed session buys one token at once, and the page reads solved only with the token in", async () => {
    const { tasks, solver } = recordingSolver();
    const transport = recaptchaPage();
    const { guardian, scripted, logs, published } = await guardedPage(transport, solver);
    scripted.calls[0]!.finish({ state: "failed", detail: "recaptcha-images: not solved in 8 rounds" });
    await eventually(() => published.length > 0);
    expect(tasks).toEqual([{ sitekey: SITEKEY, pageUrl: "https://example.test/protected?case=secret" }]);
    expect(published).toEqual([["solved", "recaptcha: token"]]);
    const evaluations = transport.sent("Runtime.evaluate", "page-session-1").map((command) => command.params!);
    expect(evaluations.some((params) => params.contextId === 9 && String(params.expression).includes(JSON.stringify(TOKEN)))).toBe(true);
    // The callback runs in the main world, where the page's global lives.
    expect(evaluations.some((params) => params.contextId === undefined && String(params.expression).includes('"onOk"'))).toBe(true);
    expect(logs.map(({ event }) => event)).toEqual(expect.arrayContaining(["token-fallback-started", "token-fallback-injected", "solved"]));
    // Settled: one token per document, and no further session.
    await sleep(POLLS);
    expect(tasks).toHaveLength(1);
    expect(scripted.calls).toHaveLength(1);
    expect(guardian.snapshot).toMatchObject({ solved: 1, failed: 0 });
    await guardian.stop();
  });

  test("trigger 2: idle sessions with the widget unsolved buy a token after the grace period, not before", async () => {
    const { tasks, solver } = recordingSolver();
    const { guardian, scripted, logs, published } = await guardedPage(recaptchaPage(), solver);
    const stop = endEverySession(scripted, { state: "idle", detail: "no challenge found" });
    await sleep(GRACE_MS / 2);
    expect(tasks).toHaveLength(0);
    await eventually(() => tasks.length === 1, 3_000);
    await eventually(() => published.length > 0);
    expect(published).toEqual([["solved", "recaptcha: token"]]);
    expect(logs.find(({ event }) => event === "token-fallback-started")?.details).toMatchObject({ after: "idle" });
    stop();
    await guardian.stop();
  });

  test("trigger 3: a solved session without a token keeps the page at solving, then buys one", async () => {
    const { tasks, solver } = recordingSolver();
    const { guardian, scripted, logs, published } = await guardedPage(recaptchaPage(), solver);
    const stop = endEverySession(scripted, { state: "solved", detail: "no challenge left" });
    await eventually(() => published.length > 0);
    // llm-captcha's own `solved` must not stand while the response field is empty.
    expect(published[0]).toEqual(["solving", "recaptcha: waiting for its response token"]);
    expect(logs.some(({ event }) => event === "solved")).toBe(false);
    await eventually(() => published.some(([state]) => state === "solved"), 3_000);
    expect(tasks).toHaveLength(1);
    expect(published.at(-1)).toEqual(["solved", "recaptcha: token"]);
    expect(guardian.snapshot.solved).toBe(1);
    stop();
    await guardian.stop();
  });

  test("a solved widget with its token is left alone, and so is a page without a visible widget", async () => {
    const { tasks, solver } = recordingSolver();
    const solved = await guardedPage(recaptchaPage({ shown: true, solved: true }), solver);
    solved.scripted.calls[0]!.finish({ state: "solved", detail: "no challenge left" });
    await eventually(() => solved.logs.some(({ event }) => event === "solved"));
    await sleep(GRACE_MS + POLLS);
    expect(tasks).toHaveLength(0);
    expect(solved.published).toEqual([]);
    await solved.guardian.stop();

    const none = await guardedPage(recaptchaPage({ shown: false, solved: false }), solver);
    none.scripted.calls[0]!.finish({ state: "failed", detail: "turnstile: blocked" });
    await sleep(GRACE_MS + POLLS);
    expect(tasks).toHaveLength(0);
    expect(none.guardian.snapshot.failed).toBe(1);
    await none.guardian.stop();
  });

  test("without a recipe provider the page reads failed with the reason, and nothing is bought", async () => {
    const { guardian, scripted, published } = await guardedPage(recaptchaPage());
    const stop = endEverySession(scripted, { state: "idle", detail: "no challenge found" });
    await eventually(() => published.length > 0, 3_000);
    expect(published).toEqual([["failed", "recaptcha: widget not reached"]]);
    expect(guardian.snapshot.failed).toBe(1);
    stop();
    await guardian.stop();
  });

  test("a provider failure is final for the document; the next document gets one more chance", async () => {
    const tasks: CaptchaTask[] = [];
    const failing: TokenCaptchaSolver = { solve: async (task) => { tasks.push(task); throw new Error("provider down"); } };
    const transport = recaptchaPage();
    const { guardian, scripted, published } = await guardedPage(transport, failing);
    scripted.calls[0]!.finish({ state: "failed", detail: "recaptcha-checkbox: blocked" });
    await eventually(() => published.length > 0);
    expect(published).toEqual([["failed", "recaptcha-checkbox: blocked; token fallback Error"]]);
    await sleep(POLLS);
    expect(tasks).toHaveLength(1);
    transport.navigate("page-session-1", "https://example.test/retry");
    await eventually(() => scripted.calls.length === 2);
    scripted.calls[1]!.finish({ state: "failed", detail: "recaptcha-checkbox: blocked" });
    await eventually(() => tasks.length === 2);
    await guardian.stop();
  });
});

describe("CAPTCHA guardian configuration", () => {
  test("normalizes a container-private browser endpoint before opening its guardian CDP connection", async () => {
    const endpoint = await resolveBrowserWebSocketEndpoint("http://fabric-browser-lease:9222", {
      fetcher: async (input) => {
        expect(String(input)).toBe("http://fabric-browser-lease:9222/json/version");
        return new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/opaque-browser-id" }), { status: 200 });
      },
    });
    expect(endpoint).toBe("ws://fabric-browser-lease:9222/devtools/browser/opaque-browser-id");
  });

  test("rejects browser endpoints containing credentials", async () => {
    await expect(resolveBrowserWebSocketEndpoint("http://user:password@browser.test:9222")).rejects.toThrow(/credentials/);
  });

  test("always enables the guardian and rejects unsafe tuning", () => {
    expect(captchaGuardianSpecFromEnvironment({})).toEqual({ enabled: true, pollIntervalMs: 1_000, solveTimeoutMs: 180_000, maxRounds: 8 });
    expect(captchaGuardianSpecFromEnvironment({ FABRIC_CAPTCHA_MAX_ROUNDS: "3", FABRIC_CAPTCHA_SOLVE_TIMEOUT_MS: "60000" })).toMatchObject({ maxRounds: 3, solveTimeoutMs: 60_000 });
    expect(() => captchaGuardianSpecFromEnvironment({ FABRIC_CAPTCHA_MAX_ROUNDS: "0" })).toThrow(/outside/);
    expect(() => captchaGuardianSpecFromEnvironment({ FABRIC_CAPTCHA_MAX_ROUNDS: "1.5" })).toThrow(/integer/);
    expect(() => captchaGuardianSpecFromEnvironment({ FABRIC_CAPTCHA_SOLVE_TIMEOUT_MS: "1000" })).toThrow(/outside/);
    expect(() => captchaGuardianSpecFromEnvironment({ FABRIC_CAPTCHA_POLL_INTERVAL_MS: "not-a-number" })).toThrow(/numeric/);
  });
});

describe("local Chromium supervision", () => {
  const localSpec = (overrides: Partial<BrowserContainerSpec> = {}): BrowserContainerSpec => ({
    workerId: "worker_local_test" as never,
    leaseId: "browser-lease_local_test" as never,
    image: "integration",
    browserVersion: "system-test",
    command: ["/usr/bin/chromium", "--headless=new"],
    environment: {},
    volumes: [],
    networks: [],
    limits: { maxBrowserLeases: 1, cpuMilli: 1_000, memoryMiB: 512, pids: 64, shmMiB: 64, temporaryStorageMiB: 128 },
    security: { dockerSocketMounted: false, hostHomeMounted: false, repositoryMounted: false, applicationSecretsMounted: false },
    cdpBind: { host: "127.0.0.1", port: 9222 },
    captchaGuardian: defaultCaptchaGuardianSpec(),
    ...overrides,
  });
  const versionFetch = async () => new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/local" }));

  test("starts the guardian before exposing readiness and stops both together", async () => {
    const process = new FakeChromiumProcess();
    const guardian = new FakeGuardian();
    const factoryInputs: Array<{ endpoint: string; enabled: boolean }> = [];
    const closed: string[] = [];
    const supervisor = new ChromiumProcessSupervisor({
      executablePath: "/usr/bin/chromium",
      startupTimeoutMs: 1_000,
      spawner: { spawn: () => process },
      fetch: versionFetch,
      captchaGuardianFactory: ({ endpoint, spec }) => {
        factoryInputs.push({ endpoint, enabled: spec.enabled });
        return guardian;
      },
      // Browser.close makes Chromium exit on its own, so no signal is needed.
      closeBrowser: async (endpoint) => { closed.push(endpoint); process.exit(); return true; },
    });
    const started = await supervisor.start(localSpec());
    expect(started.cdpBrowserEndpoint).toBe("ws://127.0.0.1:9222/devtools/browser/local");
    expect(factoryInputs).toEqual([{ endpoint: started.cdpBrowserEndpoint, enabled: true }]);
    expect(supervisor.isRunning(started.processId)).toBe(true);
    guardian.running = false;
    // A guardian that lost its browser connection fails liveness.
    expect(supervisor.isRunning(started.processId)).toBe(false);
    await supervisor.stop(started.processId);
    expect(guardian.stops).toBe(1);
    expect(closed).toEqual([started.cdpBrowserEndpoint]);
    expect(process.exitedBy).toBe("closed");
  });

  test("hands the browser the host's display session and nothing else of the host environment", async () => {
    const fake = new FakeChromiumProcess();
    const environments: NodeJS.ProcessEnv[] = [];
    const host = { DISPLAY: ":42", WAYLAND_DISPLAY: "wayland-1", XAUTHORITY: "/home/u/.Xauthority", XDG_RUNTIME_DIR: "/run/user/1000", FABRIC_HOST_ONLY: "must-not-leak" };
    const previous = Object.fromEntries(Object.keys(host).map((name) => [name, process.env[name]]));
    Object.assign(process.env, host);
    try {
      const supervisor = new ChromiumProcessSupervisor({
        executablePath: "/usr/bin/chromium",
        startupTimeoutMs: 1_000,
        spawner: { spawn: (_command, _args, options) => { environments.push(options.env); return fake; } },
        fetch: versionFetch,
        captchaGuardianFactory: () => new FakeGuardian(),
        closeBrowser: async () => { fake.exit(); return true; },
      });
      const started = await supervisor.start(localSpec({ leaseId: "browser-lease_local_display" as never, command: ["/usr/bin/chromium"], environment: { FABRIC_RUNTIME: "chrome" } }));
      await supervisor.stop(started.processId);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
    const { FABRIC_HOST_ONLY: _hostOnly, ...display } = host;
    expect(environments).toEqual([{ PATH: process.env.PATH, LANG: "C.UTF-8", ...display, FABRIC_RUNTIME: "chrome" }]);
  });

  test("falls back to signals when the browser cannot be closed through CDP", async () => {
    const process = new FakeChromiumProcess();
    const supervisor = new ChromiumProcessSupervisor({
      executablePath: "/usr/bin/chromium",
      startupTimeoutMs: 1_000,
      spawner: { spawn: () => process },
      fetch: versionFetch,
      captchaGuardianFactory: () => new FakeGuardian(),
      closeBrowser: async () => false,
    });
    const started = await supervisor.start(localSpec({ leaseId: "browser-lease_local_fallback" as never }));
    await supervisor.stop(started.processId);
    expect(process.exitedBy).toBe("SIGTERM");
    expect(supervisor.isRunning(started.processId)).toBe(false);
  });
});

test.skipIf(!browserIntegration)("real Chromium reports an ordinary GPU to a page's very first script, without exposing the override", async () => {
  const port = 23_000 + Math.floor(Math.random() * 1_000);
  const supervisor = new ChromiumProcessSupervisor({ executablePath: requireChromium(), startupTimeoutMs: 20_000, cwd: "/tmp" });
  const spec: BrowserContainerSpec = {
    workerId: "worker_fingerprint_integration" as never,
    leaseId: `browser-lease_fingerprint_${crypto.randomUUID().replaceAll("-", "")}` as never,
    image: "integration",
    browserVersion: "system-test",
    // SwiftShader is what Fabric's GPU-less servers render with.
    command: [requireChromium(), "--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    environment: {},
    volumes: [],
    networks: [],
    limits: { maxBrowserLeases: 1, cpuMilli: 2_000, memoryMiB: 2_048, pids: 256, shmMiB: 512, temporaryStorageMiB: 512 },
    security: { dockerSocketMounted: false, hostHomeMounted: false, repositoryMounted: false, applicationSecretsMounted: false },
    cdpBind: { host: "127.0.0.1", port },
    captchaGuardian: { ...defaultCaptchaGuardianSpec(), pollIntervalMs: 250 },
  };
  let processId: string | undefined;
  let browser: PuppeteerBrowser | undefined;
  try {
    const launched = await supervisor.start(spec);
    processId = launched.processId;
    browser = await puppeteer.connect({ browserWSEndpoint: launched.cdpBrowserEndpoint });
    const kit = `<script>
      const gl = document.createElement('canvas').getContext('webgl');
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      window.firstScript = {
        vendor: gl.getParameter(info.UNMASKED_VENDOR_WEBGL),
        renderer: gl.getParameter(info.UNMASKED_RENDERER_WEBGL),
        version: gl.getParameter(gl.VERSION),
        source: WebGLRenderingContext.prototype.getParameter.toString(),
        name: WebGLRenderingContext.prototype.getParameter.name,
        length: WebGLRenderingContext.prototype.getParameter.length,
        ownKeys: Object.getOwnPropertyNames(WebGLRenderingContext.prototype).filter((key) => key.startsWith('__')),
        toStringSource: Function.prototype.toString.toString(),
        toStringOfToString: Function.prototype.toString.call(Function.prototype.toString),
        ordinary: Function.prototype.toString.call(function sample() { return 1; }),
      };
    </script>`;
    // The kit's check runs inline in the first script of the document, in the open-a-page-then-navigate
    // flow every Fabric client uses.
    const page = await browser.newPage();
    await page.goto(`data:text/html,${encodeURIComponent(kit)}`, { waitUntil: "domcontentloaded", timeout: 10_000 });
    const firstScript = await page.waitForFunction(() => (window as any).firstScript, { timeout: 10_000 }).then((handle) => handle.jsonValue()) as Record<string, unknown>;

    expect(firstScript).toMatchObject({
      vendor: WEBGL_VENDOR,
      renderer: WEBGL_RENDERER,
      source: "function getParameter() { [native code] }",
      name: "getParameter",
      length: 1,
      ownKeys: [],
      toStringSource: "function toString() { [native code] }",
      toStringOfToString: "function toString() { [native code] }",
      ordinary: "function sample() { return 1; }",
    });
    expect(String(firstScript.version)).toStartWith("WebGL 1.0");
  } finally {
    await browser?.disconnect().catch(() => undefined);
    if (processId) await supervisor.stop(processId);
    await supervisor.stopAll();
  }
}, 120_000);
