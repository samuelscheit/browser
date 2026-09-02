import { describe, expect, test } from "bun:test";
import puppeteer, { type Browser as PuppeteerBrowser } from "puppeteer-core";
import { chromium } from "playwright-core";
import { ChromiumProcessSupervisor, type BrowserContainerSpec } from "@browser-fabric/worker-runtime";
import { BrowserScheduler, CapabilitySigner, FakeClock } from "@browser-fabric/control-plane";
import { CdpGateway } from "../apps/cdp-gateway/src/index";
import { TEST_PRINCIPAL, TEST_PROJECT, makeProfile, makeWorker } from "@browser-fabric/testkit";

const enabled = process.env.RUN_BROWSER_INTEGRATION === "1";
const executablePath = process.env.FABRIC_TEST_CHROMIUM ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executableExists = await Bun.file(executablePath).exists();

describe("real browser-level CDP compatibility", () => {
  test.skipIf(!enabled || !executableExists)("connects Puppeteer and Playwright to a dedicated browser endpoint", async () => {
    const port = 19_000 + Math.floor(Math.random() * 1_000);
    const supervisor = new ChromiumProcessSupervisor({ executablePath, startupTimeoutMs: 20_000, cwd: "/tmp" });
    const spec: BrowserContainerSpec = {
      workerId: "worker_integration" as never,
      leaseId: `browser-lease_integration_${crypto.randomUUID().replaceAll("-", "")}`,
      image: "integration",
      browserVersion: "system-test",
      command: [executablePath, "--headless=new"],
      environment: {},
      volumes: [],
      networks: [],
      limits: { maxBrowserLeases: 1, cpuMilli: 2_000, memoryMiB: 2_048, pids: 256, shmMiB: 512, temporaryStorageMiB: 512 },
      security: { dockerSocketMounted: false, hostHomeMounted: false, repositoryMounted: false, applicationSecretsMounted: false },
      cdpBind: { host: "127.0.0.1", port }
    };
    let processId: string | undefined;
    let puppeteerBrowser: PuppeteerBrowser | undefined;
    let playwrightBrowser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    try {
      const launch = await supervisor.start(spec);
      processId = launch.processId;
      expect(launch.cdpBrowserEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:/);
      puppeteerBrowser = await puppeteer.connect({ browserWSEndpoint: launch.cdpBrowserEndpoint });
      const pPage = await puppeteerBrowser.newPage();
      await pPage.goto("data:text/html,<title>Fabric CDP</title><input id='upload' type='file'><h1>puppeteer</h1>");
      expect(await pPage.title()).toBe("Fabric CDP");
      expect(await pPage.$eval("h1", (element) => (element as HTMLElement).textContent)).toBe("puppeteer");
      const browserContexts = await puppeteerBrowser.browserContexts();
      expect(browserContexts.length).toBeGreaterThanOrEqual(1);

      playwrightBrowser = await chromium.connectOverCDP(launch.cdpBrowserEndpoint);
      const context = playwrightBrowser.contexts()[0] ?? await playwrightBrowser.newContext();
      const page = await context.newPage();
      await page.goto("data:text/html,<title>Fabric Playwright</title><h1>playwright</h1>");
      expect(await page.title()).toBe("Fabric Playwright");
      expect(await page.locator("h1").textContent()).toBe("playwright");
      const version = await page.evaluate(() => navigator.userAgent);
      expect(version).toMatch(/Chrome|HeadlessChrome/);
      await page.close();
      await pPage.close();
    } finally {
      await playwrightBrowser?.close().catch(() => undefined);
      await puppeteerBrowser?.disconnect().catch(() => undefined);
      if (processId) await supervisor.stop(processId);
      await supervisor.stopAll();
    }
  }, 120_000);

  test.skipIf(!enabled || !executableExists)("relays browser-level CDP through the authenticated Fabric gateway", async () => {
    const browserPort = 20_000 + Math.floor(Math.random() * 500);
    const gatewayPort = browserPort + 1;
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const signer = new CapabilitySigner({ secret: "01234567890123456789012345678901", clock, gatewayBaseUrl: "wss://fabric.test" });
    const scheduler = new BrowserScheduler({ clock, capabilitySigner: signer, allowPlaintextEphemeralInputs: true });
    await scheduler.bootstrap({ projects: [{ id: TEST_PROJECT, name: "Integration" }], principals: [TEST_PRINCIPAL] });
    const worker = makeWorker({ id: "worker_gateway_integration" as never, capacity: 1, cdpRelayEndpoint: "ws://worker.internal/cdp" });
    await scheduler.registerWorker(worker);
    const profile = makeProfile(worker);
    await scheduler.createProfile(profile);
    const session = await scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "gateway-integration", runtime: "rebrowser-puppeteer", browserRecipeRef: "recipe_rebrowser-reporting@1" as never, profileRef: profile.ref, leaseMode: "writer", egressPolicyRef: "egress_reporting-residential@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 });
    const supervisor = new ChromiumProcessSupervisor({ executablePath, startupTimeoutMs: 20_000, cwd: "/tmp" });
    const spec: BrowserContainerSpec = {
      workerId: worker.id,
      leaseId: "browser-lease_gateway_bootstrap",
      image: "integration",
      browserVersion: "system-test",
      command: [executablePath, "--headless=new"],
      environment: {},
      volumes: [],
      networks: [],
      limits: { maxBrowserLeases: 1, cpuMilli: 2_000, memoryMiB: 2_048, pids: 256, shmMiB: 512, temporaryStorageMiB: 512 },
      security: { dockerSocketMounted: false, hostHomeMounted: false, repositoryMounted: false, applicationSecretsMounted: false },
      cdpBind: { host: "127.0.0.1", port: browserPort }
    };
    let browserProcess: { processId: string; cdpBrowserEndpoint: string } | undefined;
    let gatewayServer: ReturnType<typeof Bun.serve> | undefined;
    let client: PuppeteerBrowser | undefined;
    try {
      browserProcess = await supervisor.start(spec);
      await scheduler.dispatch();
      const internal = (await scheduler.store.snapshot()).sessions.get(session.id as never)!;
      const capability = new URL(internal.cdpEndpoint!).searchParams.get("cap")!;
      const upstream = {
        connect: async () => new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(browserProcess!.cdpBrowserEndpoint);
          socket.addEventListener("open", () => resolve(socket), { once: true });
          socket.addEventListener("error", () => reject(new Error("test CDP upstream failed")), { once: true });
        })
      };
      const gateway = new CdpGateway({ scheduler, capabilitySigner: signer, authenticate: () => true, upstream });
      gatewayServer = Bun.serve(gateway.createBunServeOptions(gatewayPort, "127.0.0.1"));
      client = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${gatewayPort}/v1/cdp/${session.id}?cap=${encodeURIComponent(capability)}` });
      const page = await client.newPage();
      await page.goto("data:text/html,<title>Fabric Gateway</title><h1>gateway</h1>");
      expect(await page.title()).toBe("Fabric Gateway");
      expect(await page.$eval("h1", (element) => (element as HTMLElement).textContent)).toBe("gateway");
      await page.close();
    } finally {
      await client?.disconnect().catch(() => undefined);
      gatewayServer?.stop(true);
      await scheduler.releaseBrowserSession(session.id as never).catch(() => undefined);
      if (browserProcess) await supervisor.stop(browserProcess.processId);
      await supervisor.stopAll();
    }
  }, 120_000);
});
