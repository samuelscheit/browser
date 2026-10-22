import { expect, test } from "bun:test";
import type { BrowserProcessSpec, Executor, MediaExecutor } from "../apps/worker-manager/src";
import { ManagedWorkerController } from "../apps/worker-manager/src/controller";
import { TEST_PRINCIPAL, TEST_PROJECT, bootstrapTestScheduler, makeWorker } from "@browser-fabric/testkit";
import { ArtifactCollector, MemoryObjectStore } from "@browser-fabric/control-plane";

test("managed controller revokes a ready CDP capability and releases the lease when its browser process exits", async () => {
  const { scheduler, profile, clock } = await bootstrapTestScheduler();
  // Keep the test at one managed lease so its liveness transition is unambiguous.
  const worker = makeWorker({
    id: "worker_controller" as never,
    capacity: 1,
    mediaCapacity: 0,
    capabilities: {
      ...makeWorker().capabilities,
      runtimeFamilies: ["rebrowser-puppeteer"],
      recipeRefs: ["recipe_rebrowser-reporting@1" as never],
      supportedProfileFamilies: ["reporting-reporting"],
    },
  });
  await scheduler.registerWorker(worker, TEST_PRINCIPAL);
  const controllerProfile = await scheduler.createProfile({
    ...profile,
    ref: "profile_controller" as never,
    workerId: worker.id,
    volumeName: "profile-volume",
  }, TEST_PRINCIPAL);
  const session = await scheduler.createBrowserSession({
    project: TEST_PROJECT,
    idempotencyKey: "controller-process-exit",
    runtime: "rebrowser-puppeteer",
    browserRecipeRef: "recipe_rebrowser-reporting@1" as never,
    profileRef: controllerProfile.ref,
    leaseMode: "writer",
    egressPolicyRef: "egress_direct-egress@1" as never,
    artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
    ttlSeconds: 600,
  }, TEST_PRINCIPAL);
  await scheduler.dispatch();

  let running = true;
  const started: BrowserProcessSpec[] = [];
  const stopped: string[] = [];
  const executor: Executor = {
    start: async (spec) => {
      started.push(spec);
      return { processId: "managed-browser", cdpBrowserEndpoint: "http://managed-browser:9223" };
    },
    stop: async (processId) => { stopped.push(processId); },
    isRunning: () => running,
  };
  const controller = new ManagedWorkerController({ scheduler, browserExecutor: executor, pollIntervalMs: 30_000 });

  await controller.tick();
  const ready = await scheduler.getSession(session.id, TEST_PRINCIPAL);
  expect(ready.status).toBe("ready");
  expect(ready.cdpEndpoint).toContain("cap=");
  expect(started).toHaveLength(1);

  const leaseBeforeHeartbeat = (await scheduler.store.snapshot()).leases.values().next().value;
  expect(leaseBeforeHeartbeat?.lastHeartbeatAt).toBeDefined();
  clock.advance(1);
  await controller.heartbeatActiveLeases();
  const leaseAfterHeartbeat = (await scheduler.store.snapshot()).leases.values().next().value;
  expect(leaseAfterHeartbeat?.lastHeartbeatAt).not.toBe(leaseBeforeHeartbeat?.lastHeartbeatAt);

  running = false;
  await controller.tick();
  const failed = await scheduler.getSession(session.id, TEST_PRINCIPAL);
  expect(failed.status).toBe("failed");
  expect(failed.cdpEndpoint).toBeUndefined();
  expect((await scheduler.store.snapshot()).activeBrowserLeases).toBe(0);
  expect(stopped).toEqual(["managed-browser"]);
  expect(controller.activeProcesses()).toEqual([]);
});

test("managed controller releases a media attempt immediately when its manager receipt is invalid", async () => {
  const { scheduler, worker, clock } = await bootstrapTestScheduler();
  const collector = new ArtifactCollector({ scheduler, objectStore: new MemoryObjectStore(undefined, () => clock.now()), clock: () => clock.now() });
  const policy = await scheduler.getArtifactPolicy("artifact-policy_standard-30-days@1" as never, TEST_PRINCIPAL);
  const manifest = await collector.capture({
    project: TEST_PROJECT,
    projectScoped: true,
    kind: "media_manifest",
    contentType: "application/vnd.browser-fabric.media-manifest+json",
    bytes: new TextEncoder().encode(JSON.stringify({ version: 1, mode: "relay", provider: "Media", url: "https://media.example/video.mp4", artifactKind: "video" })),
    policy,
    actor: TEST_PRINCIPAL,
  });
  const job = await scheduler.createJob({
    project: TEST_PROJECT,
    idempotencyKey: "controller-invalid-media-receipt",
    recipeRef: "recipe_media-media@1" as never,
    operation: { operation: "relay", manifestRef: manifest.id },
    egressPolicyRef: "egress_media-proxy-affinity@1" as never,
    artifactPolicyRef: policy.ref,
  }, TEST_PRINCIPAL);
  await scheduler.dispatch();

  const stopped: string[] = [];
  const mediaExecutor: MediaExecutor = {
    start: async () => ({ processId: "managed-media" }),
    wait: async () => ({ status: "succeeded", result: { receipt: "forged-receipt" } }),
    stop: async (processId) => { stopped.push(processId); },
  };
  const browserExecutor: Executor = {
    start: async () => { throw new Error("browser executor must not run a media job"); },
    stop: async () => undefined,
  };
  const controller = new ManagedWorkerController({
    scheduler,
    browserExecutor,
    mediaExecutor,
    mediaResultGateway: {
      prepare: async () => ({
        source: { version: 1, mode: "relay", provider: "Media", url: "https://media.example/video.mp4", artifactKind: "video" },
        resultEndpoint: "http://fabric-worker-manager:8083/v1/media-results/job_fixture",
        resultCapability: "x".repeat(32),
      }),
      verifyCompletion: async () => { throw new Error("manager receipt signature is invalid"); },
    },
    pollIntervalMs: 30_000,
  });

  await controller.tick();
  for (let attempt = 0; attempt < 20 && (await scheduler.getJob(job.id, TEST_PRINCIPAL)).status === "running"; attempt += 1) {
    await Bun.sleep(5);
  }
  expect((await scheduler.getJob(job.id, TEST_PRINCIPAL)).status).toBe("queued");
  expect((await scheduler.store.snapshot()).workers.get(worker.id)?.activeMediaTasks).toBe(0);
  expect(stopped).toEqual(["managed-media"]);
  expect(controller.activeProcesses()).toEqual([]);
});
