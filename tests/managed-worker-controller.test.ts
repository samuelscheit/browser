import { expect, test } from "bun:test";
import type { BrowserProcessSpec, Executor } from "../apps/worker-manager/src";
import { ManagedWorkerController } from "../apps/worker-manager/src/controller";
import { TEST_PRINCIPAL, TEST_PROJECT, bootstrapTestScheduler, makeWorker } from "@browser-fabric/testkit";
import { ArtifactCollector, MemoryObjectStore } from "@browser-fabric/control-plane";

test("managed controller revokes a ready CDP capability and releases the lease when its browser process exits", async () => {
  const { scheduler, profile, clock } = await bootstrapTestScheduler();
  // Keep the test at one managed lease so its liveness transition is unambiguous.
  const worker = makeWorker({
    id: "worker_controller" as never,
    capacity: 1,
    capabilities: {
      ...makeWorker().capabilities,
      runtimeFamilies: ["chrome"],
      recipeRefs: ["recipe_chrome-headless@1" as never],
      supportedProfileFamilies: ["default"],
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
    runtime: "chrome",
    browserRecipeRef: "recipe_chrome-headless@1" as never,
    profileRef: controllerProfile.ref,
    leaseMode: "writer",
    egressPolicyRef: "egress_direct@1" as never,
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

