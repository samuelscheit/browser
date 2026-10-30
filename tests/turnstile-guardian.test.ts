import { describe, expect, test } from "bun:test";
import {
  BROWSER_FINGERPRINT_SCRIPT,
  ChromiumProcessSupervisor,
  TURNSTILE_MOUSE_COMPAT_SCRIPT,
  TURNSTILE_OBSERVATION_SCRIPT,
  WEBGL_RENDERER,
  WEBGL_VENDOR,
  TurnstileGuardian,
  defaultTurnstileGuardianSpec,
  resolveTurnstileGuardianWebSocketEndpoint,
  turnstileGuardianSpecFromEnvironment,
  type BrowserContainerSpec,
  type CdpTransport,
  type TurnstileGuardianHandle,
  type TurnstilePageObservation,
} from "@browser-fabric/worker-runtime";
import puppeteer, { type Browser as PuppeteerBrowser } from "puppeteer-core";

type Listener = { callback: (event: any) => void; once: boolean };
const ISOLATED_CONTEXT_ID = 7;
type Command = { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };

const challengeObservation = (overrides: Partial<TurnstilePageObservation> = {}): TurnstilePageObservation => ({
  url: "https://example.test/protected",
  title: "Just a moment…",
  signals: ["title-marker"],
  // The guardian's CDP frame-tree pass supplies the actual Turnstile signal
  // and bounding box. This models a widget inside a closed shadow root, which
  // is the case Media previously handled through Patchright/Rebrowser.
  challenge: false,
  solved: false,
  boxes: [],
  ...overrides,
});

/** A deterministic browser-level CDP transport; it never evaluates page JavaScript. */
class FakeCdpTransport implements CdpTransport {
  #listeners = new Map<string, Listener[]>();
  #closed = false;
  readonly commands: Command[] = [];
  readonly #observation: TurnstilePageObservation;
  readonly #frameUrls: string[];
  readonly #documentChildren: unknown[];

  public constructor(options: {
    observation?: TurnstilePageObservation;
    frameUrl?: string;
    frameUrls?: readonly string[];
    /** Pierced DOM children of the document root, for iframes absent from the frame tree. */
    documentChildren?: unknown[];
  } = {}) {
    this.#observation = options.observation ?? challengeObservation();
    this.#frameUrls = [...(options.frameUrls ?? (options.frameUrl ? [options.frameUrl] : ["https://challenges.cloudflare.com/turnstile/v0/abc"]))];
    this.#documentChildren = options.documentChildren ?? [];
  }

  public get readyState(): number { return this.#closed ? 3 : 1; }

  public send(raw: string): void {
    if (this.#closed) throw new Error("CDP transport is closed");
    const command = JSON.parse(raw) as Command;
    this.commands.push(command);
    queueMicrotask(() => this.#emit("message", { data: JSON.stringify({ id: command.id, result: this.#result(command) }) }));
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#emit("close", {});
  }

  public addEventListener(type: "open" | "message" | "close" | "error", callback: (event: any) => void, options?: { once?: boolean }): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push({ callback, once: options?.once === true });
    this.#listeners.set(type, listeners);
  }

  public removeEventListener(type: "open" | "message" | "close" | "error", callback: (event: any) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    this.#listeners.set(type, listeners.filter((listener) => listener.callback !== callback));
  }

  #emit(type: string, event: any): void {
    const listeners = [...(this.#listeners.get(type) ?? [])];
    for (const listener of listeners) {
      listener.callback(event);
      if (listener.once) this.removeEventListener(type as "open" | "message" | "close" | "error", listener.callback);
    }
  }

  #result(command: Command): Record<string, unknown> {
    switch (command.method) {
      case "Target.getTargets":
        return { targetInfos: [{ targetId: "page-1", type: "page", url: this.#observation.url }] };
      case "Target.attachToTarget":
        return { sessionId: "page-session-1" };
      case "Page.createIsolatedWorld":
        return { executionContextId: ISOLATED_CONTEXT_ID };
      case "Runtime.evaluate":
        return command.params?.expression === TURNSTILE_OBSERVATION_SCRIPT && command.params?.contextId === ISOLATED_CONTEXT_ID
          ? { result: { type: "object", value: this.#observation } }
          : { result: { type: "undefined" } };
      case "Page.getFrameTree":
        return {
          frameTree: {
            frame: { id: "top", url: this.#observation.url },
            childFrames: this.#frameUrls.map((url, index) => ({ frame: { id: `turnstile-frame-${index + 1}`, url } })),
          },
        };
      case "DOM.getDocument":
        return { root: { nodeName: "#document", backendNodeId: 1, children: this.#documentChildren } };
      case "DOM.getFrameOwner":
        return { backendNodeId: 73 + Math.max(0, Number(String(command.params?.frameId ?? "").split("-").pop()) - 1) };
      case "DOM.getBoxModel":
        {
          const offset = (Number(command.params?.backendNodeId ?? 73) - 73) * 340;
          return { model: { content: [10 + offset, 20, 310 + offset, 20, 310 + offset, 100, 10 + offset, 100] } };
        }
      case "DOM.resolveNode":
        return { object: { objectId: `frame-owner-${command.params?.backendNodeId}` } };
      case "Runtime.callFunctionOn":
        return { result: { type: "boolean", value: true } };
      default:
        return {};
    }
  }

  public emitEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.#emit("message", { data: JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }) });
  }
}

class FakeChromiumProcess {
  public readonly pid = 4242;
  #listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  #exited = false;

  public once(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  public kill(): boolean {
    if (this.#exited) return false;
    this.#exited = true;
    for (const listener of this.#listeners.get("exit") ?? []) listener();
    return true;
  }
}

class FakeGuardian implements TurnstileGuardianHandle {
  public starts = 0;
  public stops = 0;
  public running = true;

  public get snapshot() {
    return { running: this.running, attachedPages: 0, checks: 0, clickAttempts: 0 };
  }

  public async start(): Promise<void> { this.starts += 1; }
  public async stop(): Promise<void> { this.stops += 1; this.running = false; }
}

function inputEvents(transport: FakeCdpTransport): Command[] {
  return transport.commands.filter((command) => command.method === "Input.dispatchMouseEvent");
}

function buttonEvents(transport: FakeCdpTransport): Command[] {
  return inputEvents(transport).filter((command) => command.params?.type === "mousePressed" || command.params?.type === "mouseReleased");
}

describe("Fabric Turnstile guardian", () => {
  test("normalizes a container-private browser endpoint before opening its guardian CDP connection", async () => {
    const endpoint = await resolveTurnstileGuardianWebSocketEndpoint("http://fabric-browser-lease:9222", {
      fetcher: async (input) => {
        expect(String(input)).toBe("http://fabric-browser-lease:9222/json/version");
        return new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/opaque-browser-id" }), { status: 200 });
      },
    });
    expect(endpoint).toBe("ws://fabric-browser-lease:9222/devtools/browser/opaque-browser-id");
  });

  test("automatically detects a Cloudflare Turnstile frame, including one in a closed shadow root, and sends one bounded real-input click", async () => {
    const transport = new FakeCdpTransport();
    const logs: Array<{ event: string; details?: Record<string, unknown> }> = [];
    const guardian = new TurnstileGuardian({
      endpoint: "ws://browser.test/devtools/browser/guardian",
      transportFactory: async (url) => {
        expect(url).toBe("ws://browser.test/devtools/browser/guardian");
        return transport;
      },
      maxClickAttempts: 1,
      pollIntervalMs: 30_000,
      logger: (event, details) => logs.push({ event, details }),
    });

    await guardian.start();

    expect(transport.commands.map((command) => command.method)).toEqual(expect.arrayContaining([
      "Target.setDiscoverTargets",
      "Target.setAutoAttach",
      "Target.getTargets",
      "Target.attachToTarget",
      "DOM.getFrameOwner",
      "DOM.getBoxModel",
    ]));
    const events = inputEvents(transport);
    expect(events.length).toBeGreaterThan(2);
    expect(events.some((event) => event.params?.type === "mousePressed")).toBe(true);
    expect(events.some((event) => event.params?.type === "mouseReleased")).toBe(true);
    expect(events.every((event) => event.sessionId === "page-session-1")).toBe(true);
    expect(guardian.snapshot).toMatchObject({ running: true, attachedPages: 1, clickAttempts: 1 });
    expect(logs.some(({ event }) => event === "detected")).toBe(true);
    expect(logs.some(({ event }) => event === "clicked")).toBe(true);

    await guardian.stop();
    expect(transport.readyState).toBe(3);
  });

  test("probes the page only from its own isolated world, never the main world Cloudflare watches", async () => {
    const transport = new FakeCdpTransport();
    const guardian = new TurnstileGuardian({
      endpoint: "ws://browser.test/devtools/browser/isolated-world",
      transportFactory: async () => transport,
      maxClickAttempts: 1,
      pollIntervalMs: 30_000,
      logger: () => undefined,
    });

    await guardian.start();

    const worlds = transport.commands.filter((command) => command.method === "Page.createIsolatedWorld");
    expect(worlds).toHaveLength(1);
    expect(worlds[0]?.params).toMatchObject({ frameId: "top", worldName: "fabric-turnstile-guardian" });
    const observations = transport.commands.filter((command) => command.method === "Runtime.evaluate" && command.params?.expression === TURNSTILE_OBSERVATION_SCRIPT);
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every((command) => command.params?.contextId === ISOLATED_CONTEXT_ID)).toBe(true);
    const resolutions = transport.commands.filter((command) => command.method === "DOM.resolveNode");
    expect(resolutions.length).toBeGreaterThan(0);
    expect(resolutions.every((command) => command.params?.executionContextId === ISOLATED_CONTEXT_ID)).toBe(true);
    expect(guardian.snapshot.clickAttempts).toBe(1);
    await guardian.stop();
  });

  test("finds a Turnstile iframe absent from the frame tree inside a closed shadow root", async () => {
    // Cloudflare's managed challenge page: the frame tree lists no child frame,
    // and the widget iframe sits in a closed shadow root of the challenge host.
    const transport = new FakeCdpTransport({
      frameUrls: [],
      documentChildren: [{
        nodeName: "HTML",
        backendNodeId: 2,
        children: [{
          nodeName: "DIV",
          backendNodeId: 3,
          shadowRoots: [{
            nodeName: "#document-fragment",
            backendNodeId: 4,
            children: [{ nodeName: "IFRAME", backendNodeId: 73, attributes: ["src", "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/f/av0/rch/x/0xAA/light/fbE/new/normal"] }],
          }],
        }, { nodeName: "IFRAME", backendNodeId: 74, attributes: ["src", "https://ads.example/frame"] }],
      }],
    });
    const guardian = new TurnstileGuardian({
      endpoint: "ws://browser.test/devtools/browser/closed-shadow-root",
      transportFactory: async () => transport,
      maxClickAttempts: 1,
      pollIntervalMs: 30_000,
      logger: () => undefined,
    });

    await guardian.start();

    expect(transport.commands.find((command) => command.method === "DOM.getDocument")?.params).toMatchObject({ depth: -1, pierce: true });
    expect(transport.commands.filter((command) => command.method === "DOM.getBoxModel").map((command) => command.params?.backendNodeId)).toEqual([73]);
    expect(buttonEvents(transport)).toHaveLength(2);
    expect(guardian.snapshot.clickAttempts).toBe(1);
    await guardian.stop();
  });

  test("creates a fresh isolated world after the top-level document navigates", async () => {
    const transport = new FakeCdpTransport();
    const guardian = new TurnstileGuardian({
      endpoint: "ws://browser.test/devtools/browser/isolated-world-navigation",
      transportFactory: async () => transport,
      pollIntervalMs: 250,
      logger: () => undefined,
    });

    await guardian.start();
    transport.emitEvent("Page.frameNavigated", { frame: { id: "top", url: "https://example.test/next" } }, "page-session-1");
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(transport.commands.filter((command) => command.method === "Page.createIsolatedWorld")).toHaveLength(2);
    await guardian.stop();
  });

  test("tracks multiple visible Turnstile instances independently", async () => {
    const transport = new FakeCdpTransport({
      frameUrls: [
        "https://challenges.cloudflare.com/turnstile/v0/first",
        "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/second",
      ],
    });
    const guardian = new TurnstileGuardian({
      endpoint: "ws://browser.test/devtools/browser/multiple-widgets",
      transportFactory: async () => transport,
      maxClickAttempts: 1,
      pollIntervalMs: 30_000,
      logger: () => undefined,
    });

    await guardian.start();

    expect(buttonEvents(transport)).toHaveLength(4);
    expect(guardian.snapshot.clickAttempts).toBe(2);
    await guardian.stop();
  });

  test("does not click a solved Turnstile response even if its challenge iframe remains in the frame tree", async () => {
    const transport = new FakeCdpTransport({ observation: challengeObservation({ solved: true, challenge: false, signals: ["turnstile-field"] }) });
    const guardian = new TurnstileGuardian({
      endpoint: "ws://browser.test/devtools/browser/solved",
      transportFactory: async () => transport,
      pollIntervalMs: 30_000,
      logger: () => undefined,
    });

    await guardian.start();

    expect(buttonEvents(transport)).toHaveLength(0);
    expect(guardian.snapshot.clickAttempts).toBe(0);
    await guardian.stop();
  });

  test("does not treat a non-Cloudflare CAPTCHA frame as a Turnstile target", async () => {
    const transport = new FakeCdpTransport({ frameUrl: "https://hcaptcha.example/challenge/abc" });
    const guardian = new TurnstileGuardian({
      endpoint: "ws://browser.test/devtools/browser/non-cloudflare",
      transportFactory: async () => transport,
      pollIntervalMs: 30_000,
      logger: () => undefined,
    });

    await guardian.start();

    expect(buttonEvents(transport)).toHaveLength(0);
    expect(guardian.snapshot.clickAttempts).toBe(0);
    await guardian.stop();
  });

  test("does not click an untrusted iframe whose URL merely mentions Cloudflare", async () => {
    const transport = new FakeCdpTransport({ frameUrl: "https://evil.example/frame?next=challenges.cloudflare.com/turnstile/v0/abc" });
    const guardian = new TurnstileGuardian({
      endpoint: "ws://browser.test/devtools/browser/untrusted-frame",
      transportFactory: async () => transport,
      pollIntervalMs: 30_000,
      logger: () => undefined,
    });

    await guardian.start();

    expect(buttonEvents(transport)).toHaveLength(0);
    expect(guardian.snapshot.clickAttempts).toBe(0);
    await guardian.stop();
  });

  test("keeps the first page CDP session when auto-attach races its explicit attach fallback", async () => {
    const transport = new FakeCdpTransport();
    const guardian = new TurnstileGuardian({
      endpoint: "ws://browser.test/devtools/browser/attach-race",
      transportFactory: async () => transport,
      pollIntervalMs: 30_000,
      logger: () => undefined,
    });

    await guardian.start();
    transport.emitEvent("Target.attachedToTarget", {
      sessionId: "duplicate-page-session",
      targetInfo: { targetId: "page-1", type: "page", url: "https://example.test/protected" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(guardian.snapshot.attachedPages).toBe(1);
    expect(transport.commands.some((command) => command.method === "Target.detachFromTarget" && command.params?.sessionId === "duplicate-page-session")).toBe(true);
    await guardian.stop();
  });

  test("installs the GPU identity on every page it attaches, before its Turnstile mouse hint", async () => {
    const transport = new FakeCdpTransport();
    const guardian = new TurnstileGuardian({
      endpoint: "ws://browser.test/devtools/browser/fingerprint",
      transportFactory: async () => transport,
      pollIntervalMs: 30_000,
      logger: () => undefined,
    });

    await guardian.start();
    transport.emitEvent("Target.attachedToTarget", {
      sessionId: "new-page-session",
      targetInfo: { targetId: "page-2", type: "page", url: "about:blank" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    for (const sessionId of ["page-session-1", "new-page-session"]) {
      const documentStart = transport.commands
        .filter((command) => command.sessionId === sessionId && command.method === "Page.addScriptToEvaluateOnNewDocument")
        .map((command) => command.params?.source);
      expect(documentStart).toEqual([BROWSER_FINGERPRINT_SCRIPT, TURNSTILE_MOUSE_COMPAT_SCRIPT]);
      // The page's current document gets the identity too.
      expect(transport.commands.some((command) => command.sessionId === sessionId && command.method === "Runtime.evaluate" && command.params?.expression === BROWSER_FINGERPRINT_SCRIPT)).toBe(true);
    }
    await guardian.stop();
  });

  test("detaches auxiliary auto-attached targets and keeps page coverage isolated", async () => {
    const transport = new FakeCdpTransport();
    const guardian = new TurnstileGuardian({
      endpoint: "ws://browser.test/devtools/browser/auxiliary-target",
      transportFactory: async () => transport,
      pollIntervalMs: 30_000,
      logger: () => undefined,
    });

    await guardian.start();
    transport.emitEvent("Target.attachedToTarget", {
      sessionId: "oopif-session",
      targetInfo: { targetId: "frame-target", type: "iframe", url: "https://challenges.cloudflare.com/turnstile/v0/abc" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.commands.some((command) => command.method === "Target.detachFromTarget" && command.params?.sessionId === "oopif-session")).toBe(true);
    expect(guardian.snapshot.attachedPages).toBe(1);
    await guardian.stop();
  });

  test("does not reset a bounded click budget when the embedded Turnstile frame navigates", async () => {
    const transport = new FakeCdpTransport();
    const guardian = new TurnstileGuardian({
      endpoint: "ws://browser.test/devtools/browser/frame-navigation",
      transportFactory: async () => transport,
      pollIntervalMs: 30_000,
      maxClickAttempts: 1,
      logger: () => undefined,
    });

    await guardian.start();
    transport.emitEvent("Page.frameNavigated", {
      frame: { id: "turnstile-frame", parentId: "top", url: "https://challenges.cloudflare.com/turnstile/v0/reloaded" },
    }, "page-session-1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(guardian.snapshot.clickAttempts).toBe(1);
    await guardian.stop();
  });

  test("does not log page payloads when a challenge uses an opaque URL", async () => {
    const inlinePayload = "data:text/html,%3Cinput%20value%3D%22page-private-value%22%3E";
    const transport = new FakeCdpTransport({ observation: challengeObservation({ url: inlinePayload }) });
    const logs: Array<{ event: string; details?: Record<string, unknown> }> = [];
    const guardian = new TurnstileGuardian({
      endpoint: "ws://browser.test/devtools/browser/log-safety",
      transportFactory: async () => transport,
      maxClickAttempts: 1,
      pollIntervalMs: 30_000,
      logger: (event, details) => logs.push({ event, details }),
    });

    await guardian.start();

    expect(JSON.stringify(logs)).not.toContain("page-private-value");
    expect(logs.find(({ event }) => event === "detected")?.details?.url).toBe("data");
    await guardian.stop();
  });

  test("always enables the guardian and rejects unsafe timing configuration", () => {
    expect(turnstileGuardianSpecFromEnvironment({})).toMatchObject({
      enabled: true,
      pollIntervalMs: 1_000,
      challengeTimeoutMs: 12_000,
      maxClickAttempts: 5,
    });
    expect(() => turnstileGuardianSpecFromEnvironment({ FABRIC_TURNSTILE_MAX_CLICK_ATTEMPTS: "0" })).toThrow(/outside/);
    expect(() => turnstileGuardianSpecFromEnvironment({ FABRIC_TURNSTILE_MAX_CLICK_ATTEMPTS: "1.5" })).toThrow(/integer/);
    expect(() => turnstileGuardianSpecFromEnvironment({ FABRIC_TURNSTILE_POLL_INTERVAL_MS: "not-a-number" })).toThrow(/numeric/);
  });

  test("rejects browser endpoints containing credentials", async () => {
    await expect(resolveTurnstileGuardianWebSocketEndpoint("http://user:password@browser.test:9222")).rejects.toThrow(/credentials/);
  });

  test("fails its health snapshot closed when the guardian CDP channel disappears", async () => {
    const transport = new FakeCdpTransport();
    const guardian = new TurnstileGuardian({
      endpoint: "ws://browser.test/devtools/browser/lost-connection",
      transportFactory: async () => transport,
      pollIntervalMs: 30_000,
      logger: () => undefined,
    });

    await guardian.start();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(guardian.snapshot).toMatchObject({ running: false, attachedPages: 0 });
    expect(guardian.snapshot.lastError).toBe("Turnstile guardian CDP connection closed");
    await guardian.stop();
  });

  test("local Chromium supervision starts the guardian before exposing readiness and stops both together", async () => {
    const process = new FakeChromiumProcess();
    const guardian = new FakeGuardian();
    const factoryInputs: Array<{ endpoint: string; enabled: boolean }> = [];
    const supervisor = new ChromiumProcessSupervisor({
      executablePath: "/usr/bin/chromium",
      startupTimeoutMs: 1_000,
      spawner: { spawn: () => process },
      fetch: async () => new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/local" })),
      turnstileGuardianFactory: ({ endpoint, spec }) => {
        factoryInputs.push({ endpoint, enabled: spec.enabled });
        return guardian;
      },
    });
    const spec: BrowserContainerSpec = {
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
      turnstileGuardian: defaultTurnstileGuardianSpec(),
    };

    const started = await supervisor.start(spec);
    expect(started.cdpBrowserEndpoint).toBe("ws://127.0.0.1:9222/devtools/browser/local");
    expect(factoryInputs).toEqual([{ endpoint: started.cdpBrowserEndpoint, enabled: true }]);
    expect(supervisor.isRunning(started.processId)).toBe(true);
    await supervisor.stop(started.processId);
    expect(guardian.stops).toBe(1);
    expect(supervisor.isRunning(started.processId)).toBe(false);
  });
});

const realBrowserEnabled = process.env.RUN_BROWSER_INTEGRATION === "1";
const chromeExecutable = process.env.FABRIC_TEST_CHROMIUM ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromeAvailable = await Bun.file(chromeExecutable).exists();

test.skipIf(!realBrowserEnabled || !chromeAvailable)("real Chromium receives the guardian before a raw-CDP client opens a page and clicks an arbitrary Cloudflare Turnstile widget", async () => {
  const port = 23_000 + Math.floor(Math.random() * 1_000);
  const supervisor = new ChromiumProcessSupervisor({ executablePath: chromeExecutable, startupTimeoutMs: 20_000, cwd: "/tmp" });
  const spec: BrowserContainerSpec = {
    workerId: "worker_turnstile_integration" as never,
    leaseId: `browser-lease_turnstile_${crypto.randomUUID().replaceAll("-", "")}` as never,
    image: "integration",
    browserVersion: "system-test",
    command: [chromeExecutable, "--headless=new"],
    environment: {},
    volumes: [],
    networks: [],
    limits: { maxBrowserLeases: 1, cpuMilli: 2_000, memoryMiB: 2_048, pids: 256, shmMiB: 512, temporaryStorageMiB: 512 },
    security: { dockerSocketMounted: false, hostHomeMounted: false, repositoryMounted: false, applicationSecretsMounted: false },
    cdpBind: { host: "127.0.0.1", port },
    turnstileGuardian: { ...defaultTurnstileGuardianSpec(), pollIntervalMs: 250, maxClickAttempts: 1 },
  };
  let processId: string | undefined;
  let browser: PuppeteerBrowser | undefined;
  try {
    const launched = await supervisor.start(spec);
    processId = launched.processId;
    // The raw-CDP client is deliberately attached after the guardian. Its page
    // is an arbitrary application page, not a Media-specific browser flow.
    browser = await puppeteer.connect({ browserWSEndpoint: launched.cdpBrowserEndpoint });
    const page = await browser.newPage();
    await page.goto(`data:text/html,${encodeURIComponent(`
      <title>Fabric Turnstile integration</title>
      <input name="cf-turnstile-response" value="">
      <iframe src="https://challenges.cloudflare.com/turnstile/v0/abc" style="display:block;width:300px;height:80px;border:0"></iframe>
    `)}`, { waitUntil: "domcontentloaded", timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    // The supervisor reports guardian liveness and counters as part of process
    // health. The synthetic iframe cannot solve (there is no real Cloudflare
    // backend), but its input counter proves that a raw-CDP page received the
    // automatic process-level clicker without a Media application client.
    expect(supervisor.isRunning(launched.processId)).toBe(true);
    expect(supervisor.guardianSnapshot(launched.processId)).toMatchObject({ running: true, clickAttempts: 1 });
    await page.close();
  } finally {
    await browser?.disconnect().catch(() => undefined);
    if (processId) await supervisor.stop(processId);
    await supervisor.stopAll();
  }
}, 120_000);

test.skipIf(!realBrowserEnabled || !chromeAvailable)("real Chromium reports an ordinary GPU to a page's very first script, without exposing the override", async () => {
  const port = 23_000 + Math.floor(Math.random() * 1_000);
  const supervisor = new ChromiumProcessSupervisor({ executablePath: chromeExecutable, startupTimeoutMs: 20_000, cwd: "/tmp" });
  const spec: BrowserContainerSpec = {
    workerId: "worker_fingerprint_integration" as never,
    leaseId: `browser-lease_fingerprint_${crypto.randomUUID().replaceAll("-", "")}` as never,
    image: "integration",
    browserVersion: "system-test",
    // SwiftShader is what Fabric's GPU-less servers render with.
    command: [chromeExecutable, "--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    environment: {},
    volumes: [],
    networks: [],
    limits: { maxBrowserLeases: 1, cpuMilli: 2_000, memoryMiB: 2_048, pids: 256, shmMiB: 512, temporaryStorageMiB: 512 },
    security: { dockerSocketMounted: false, hostHomeMounted: false, repositoryMounted: false, applicationSecretsMounted: false },
    cdpBind: { host: "127.0.0.1", port },
    turnstileGuardian: { ...defaultTurnstileGuardianSpec(), pollIntervalMs: 250 },
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
    // The kit's check runs inline in the first script of the document, in
    // the open-a-page-then-navigate flow every Fabric client uses.
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
