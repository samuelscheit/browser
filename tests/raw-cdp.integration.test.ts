import { describe, expect, test } from "bun:test";
import puppeteer, { type Browser as PuppeteerBrowser } from "puppeteer-core";
import { chromium } from "playwright-core";
import { createServer as createTcpServer, type Server, type Socket } from "node:net";
import { ChromiumProcessSupervisor, type BrowserContainerSpec } from "@browser-fabric/worker-runtime";
import { BrowserScheduler, CapabilitySigner, FakeClock } from "@browser-fabric/control-plane";
import { CdpGateway } from "../apps/cdp-gateway/src/index";
import { OutboundCdpRelay } from "../apps/local-agent/src/cdp-relay";
import { buildBrowserProcessSpec } from "../apps/worker-manager/src";
import { parseEgressConfig } from "../apps/egress-sidecar/src/config";
import { startEgressSidecar, type EgressSidecarHandle } from "../apps/egress-sidecar/src/server";
import { TEST_PRINCIPAL, TEST_PROJECT, makeProfile, makeWorker } from "@browser-fabric/testkit";

const enabled = process.env.RUN_BROWSER_INTEGRATION === "1";
const executablePath = process.env.FABRIC_TEST_CHROMIUM ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executableExists = await Bun.file(executablePath).exists();

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => { server.removeListener("listening", ready); reject(error); };
    const ready = () => { server.removeListener("error", fail); resolve(); };
    server.once("error", fail);
    server.once("listening", ready);
    server.listen(0, "127.0.0.1");
  });
  return (server.address() as { port: number }).port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

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
      const [assignment] = await scheduler.dispatch();
      const workerActor = { ...TEST_PRINCIPAL, certificateFingerprint: worker.certificateFingerprint };
      await scheduler.claimAssignment(worker.id, assignment!.lease!.id, undefined, workerActor);
      await scheduler.markLeaseStarted(assignment!.lease!.id, worker.id, workerActor);
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

  test.skipIf(!enabled || !executableExists)("relays a federated local worker through the gateway before issuing readiness", async () => {
    const browserPort = 21_000 + Math.floor(Math.random() * 400);
    const gatewayPort = browserPort + 1;
    const egressListenerPort = gatewayPort + 1;
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const signer = new CapabilitySigner({ secret: "01234567890123456789012345678901", clock, gatewayBaseUrl: "wss://fabric.test" });
    const scheduler = new BrowserScheduler({ clock, capabilitySigner: signer, allowPlaintextEphemeralInputs: true });
    await scheduler.bootstrap({ projects: [{ id: TEST_PROJECT, name: "Federated integration" }], principals: [TEST_PRINCIPAL] });
    const worker = makeWorker({
      id: "worker_local_federated" as never,
      isLocal: true,
      capacity: 1,
      mediaCapacity: 0,
      cdpRelayEndpoint: "ws://127.0.0.1:9222",
      volumeNames: ["profile-federated"],
      capabilities: {
        ...makeWorker().capabilities,
        runtimeFamilies: ["chromium-cdp"],
        recipeRefs: ["recipe_interactive-chromium@1" as never],
        supportsInteractive: true,
        supportedProfileFamilies: ["interactive"],
      },
    });
    await scheduler.registerWorker(worker);
    const profile = makeProfile(worker, { ref: "profile_federated" as never, profileFamily: "interactive", volumeName: "profile-federated" });
    await scheduler.createProfile(profile, TEST_PRINCIPAL);
    const session = await scheduler.createBrowserSession({
      project: TEST_PROJECT,
      idempotencyKey: "federated-gateway-integration",
      runtime: "chromium-cdp",
      browserRecipeRef: "recipe_interactive-chromium@1" as never,
      profileRef: profile.ref,
      leaseMode: "interactive",
      egressPolicyRef: "egress_reporting-residential@1" as never,
      artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
      ttlSeconds: 600,
    }, TEST_PRINCIPAL);
    const [allocated] = await scheduler.dispatch();
    if (!allocated?.lease) throw new Error("federated session was not allocated");
    const workerActor = { ...TEST_PRINCIPAL, certificateFingerprint: worker.certificateFingerprint };
    const claimed = await scheduler.claimAssignment(worker.id, allocated.lease.id, undefined, workerActor);
    const claimedLeaseId = claimed.lease?.id;
    if (!claimedLeaseId) throw new Error("federated assignment lost its lease");
    const supervisor = new ChromiumProcessSupervisor({ executablePath, startupTimeoutMs: 20_000, cwd: "/tmp", profileRoot: `/tmp/fabric-federated-${crypto.randomUUID()}` });
    let browserProcess: { processId: string; cdpBrowserEndpoint: string } | undefined;
    let gatewayServer: ReturnType<typeof Bun.serve> | undefined;
    let relay: OutboundCdpRelay | undefined;
    let client: PuppeteerBrowser | undefined;
    let egress: EgressSidecarHandle | undefined;
    const upstreamProxy = createTcpServer();
    const upstreamSockets = new Set<Socket>();
    const upstreamConnects: string[] = [];
    const upstreamRequests: string[] = [];
    const previousPacBaseUrl = process.env.FABRIC_EGRESS_PAC_BASE_URL;
    try {
      upstreamProxy.on("connection", (socket) => {
        upstreamSockets.add(socket);
        socket.once("close", () => upstreamSockets.delete(socket));
        let buffer = "";
        let connected = false;
        socket.on("data", (chunk) => {
          buffer += chunk.toString("latin1");
          if (!connected) {
            const boundary = buffer.indexOf("\r\n\r\n");
            if (boundary < 0) return;
            const connectHeader = buffer.slice(0, boundary + 4);
            upstreamConnects.push(connectHeader);
            buffer = buffer.slice(boundary + 4);
            connected = true;
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          }
          if (connected && buffer.includes("GET ")) {
            upstreamRequests.push(buffer);
            socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 72\r\nConnection: close\r\n\r\n<title>Fabric Egress Relay</title><h1>through-the-sidecar</h1>");
          }
        });
      });
      const upstreamPort = await listen(upstreamProxy);
      // The federated worker has host-network egress. Start the real loopback-only Fabric
      // sidecar before Chromium and make the supervisor prove the PAC is live and fail-closed.
      // Its upstream is a local test proxy: Chromium -> PAC -> Fabric listener -> upstream is
      // asserted below, proving the local browser did not use its host default route.
      egress = await startEgressSidecar({
        config: parseEgressConfig({
          version: 1,
          listeners: [{ id: "reporting", port: egressListenerPort, bindHost: "127.0.0.1", mode: "proxy", upstreamUrls: [`http://127.0.0.1:${upstreamPort}`] }],
          policies: [{ ref: "egress_reporting-residential@1", defaultListenerId: "reporting" }],
        }),
        pacPort: 0,
        pacHost: "127.0.0.1",
        bindHost: "127.0.0.1",
      });
      process.env.FABRIC_EGRESS_PAC_BASE_URL = egress.pacBaseUrl;
      const spec = buildBrowserProcessSpec(worker, claimed);
      browserProcess = await supervisor.start(spec.container);
      const gateway = new CdpGateway({ scheduler, capabilitySigner: signer, authenticate: () => true, upstream: { connect: async () => { throw new Error("reverse test must not use direct upstream"); } } });
      gatewayServer = Bun.serve(gateway.createBunServeOptions(gatewayPort, "127.0.0.1"));
      relay = new OutboundCdpRelay({
        gatewayUrl: `ws://127.0.0.1:${gatewayPort}/v1/worker-relay/{workerId}/{leaseId}`,
        workerId: worker.id,
        leaseId: claimedLeaseId,
        browserEndpoint: browserProcess.cdpBrowserEndpoint,
        headers: { "x-fabric-worker-cert-fingerprint": worker.certificateFingerprint },
      });
      await relay.start();
      expect(relay.connected).toBe(true);
      await scheduler.markLeaseStarted(claimedLeaseId, worker.id, workerActor);
      const publicSession = await scheduler.getSession(session.id, TEST_PRINCIPAL);
      const publicUrl = new URL(publicSession.cdpEndpoint!);
      const capability = publicUrl.searchParams.get("cap");
      expect(capability).toBeTruthy();
      client = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${gatewayPort}/v1/cdp/${session.id}?cap=${encodeURIComponent(capability!)}` });
      const page = await client.newPage();
      await page.goto("http://example.test/fabric-egress");
      expect(await page.title()).toBe("Fabric Egress Relay");
      expect(await page.$eval("h1", (element) => (element as HTMLElement).textContent)).toBe("through-the-sidecar");
      expect(upstreamConnects.some((request) => request.includes("CONNECT example.test:80 HTTP/1.1"))).toBe(true);
      expect(upstreamRequests.some((request) => request.includes("GET /fabric-egress HTTP/1.1"))).toBe(true);
      await page.close();
    } finally {
      await client?.disconnect().catch(() => undefined);
      await relay?.stop().catch(() => undefined);
      gatewayServer?.stop(true);
      await scheduler.releaseBrowserSession(session.id as never, TEST_PRINCIPAL).catch(() => undefined);
      if (browserProcess) await supervisor.stop(browserProcess.processId);
      await supervisor.stopAll();
      await egress?.close().catch(() => undefined);
      for (const socket of upstreamSockets) socket.destroy();
      await closeServer(upstreamProxy);
      if (previousPacBaseUrl === undefined) delete process.env.FABRIC_EGRESS_PAC_BASE_URL;
      else process.env.FABRIC_EGRESS_PAC_BASE_URL = previousPacBaseUrl;
    }
  }, 120_000);
});
