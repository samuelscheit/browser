import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { FabricError } from "@browser-fabric/contracts";
import { createTestScheduler } from "@browser-fabric/testkit";
import { parseProvisionManifest, provisionManifest, type ProvisionManifest } from "../apps/worker-manager/src/provision-fabric";

const exampleManifestPath = new URL("../deploy/compose/provision-manifest.example.json", import.meta.url);

async function exampleManifest(): Promise<ProvisionManifest> {
  return parseProvisionManifest(JSON.parse(await readFile(exampleManifestPath, "utf8")));
}

/** Dispatch a writer session onto the manifest's first worker, so the worker owns an active lease. */
async function holdActiveLease(runtime: Awaited<ReturnType<typeof provisionRuntime>>, manifest: ProvisionManifest, idempotencyKey: string): Promise<void> {
  const worker = manifest.workers[0]!;
  const profile = manifest.profiles[0]!;
  const session = await runtime.scheduler.createBrowserSession({
    project: profile.ownerProject,
    idempotencyKey,
    runtime: worker.capabilities.runtimeFamilies[0]!,
    browserRecipeRef: worker.capabilities.recipeRefs[0]!,
    profileRef: profile.ref,
    leaseMode: "writer",
    egressPolicyRef: "egress_direct-egress@1" as never,
    artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
    ttlSeconds: 600,
  }, manifest.principals[0]!);
  expect((await runtime.scheduler.dispatch()).map((assignment) => assignment.session?.id)).toContain(session.id);
}

async function provisionRuntime() {
  const { scheduler } = createTestScheduler();
  // Production bootstrap installs immutable recipes/policies before creating identities. Mirror
  // that here without registering the manifest's identities, which is the behavior under test.
  await scheduler.bootstrap();
  return { scheduler };
}

describe("Fabric provisioning manifests", () => {
  test("accepts the published example and reports its intended creates without exposing values", async () => {
    const manifest = await exampleManifest();

    expect(manifest.workers).toHaveLength(1);
    expect(manifest.workers[0]?.enrollmentTokenHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.workers[0]?.enrollmentTokenHash).not.toContain("replace-with");

    const plan = await provisionManifest(await provisionRuntime(), manifest, true);
    expect(plan).toEqual({
      projectsToCreate: [manifest.projects[0]!.id],
      principalsToCreate: [manifest.principals[0]!.id],
      workersToCreate: [manifest.workers[0]!.id],
      workersToEnableInteractive: [],
      workersToMigrateCdpBridge: [],
      workersToResize: [],
      profilesToCreate: [manifest.profiles[0]!.ref]
    });
    expect(JSON.stringify(plan)).not.toContain("enrollmentTokenHash");
  });

  test("rejects raw secret-shaped fields before any provisioning action", async () => {
    const raw = JSON.parse(await readFile(exampleManifestPath, "utf8")) as Record<string, unknown>;
    (raw.workers as Array<Record<string, unknown>>)[0]!.enrollmentToken = "not-allowed-even-for-tests";

    expect(() => parseProvisionManifest(raw)).toThrow(FabricError);
    expect(() => parseProvisionManifest(raw)).toThrow(/enrollmentToken must not appear/);
  });

  test("creates dependencies in order and replays an unchanged manifest idempotently", async () => {
    const manifest = await exampleManifest();
    const runtime = await provisionRuntime();

    const first = await provisionManifest(runtime, manifest);
    expect(first.projectsToCreate).toEqual([manifest.projects[0]!.id]);
    expect(first.principalsToCreate).toEqual([manifest.principals[0]!.id]);
    expect(first.workersToCreate).toEqual([manifest.workers[0]!.id]);
    expect(first.profilesToCreate).toEqual([manifest.profiles[0]!.ref]);

    const snapshot = await runtime.scheduler.store.snapshot();
    expect(snapshot.projects.get(manifest.projects[0]!.id)?.name).toBe("Reporting Support");
    expect(snapshot.principals.get(manifest.principals[0]!.id)?.roles).toContain("fabric_admin");
    expect(snapshot.workers.get(manifest.workers[0]!.id)?.volumeNames).toContain(manifest.profiles[0]!.volumeName);
    expect(snapshot.profiles.get(manifest.profiles[0]!.ref)?.workerId).toBe(manifest.workers[0]!.id);

    const replay = await provisionManifest(runtime, manifest);
    expect(replay).toEqual({ projectsToCreate: [], principalsToCreate: [], workersToCreate: [], workersToEnableInteractive: [], workersToMigrateCdpBridge: [], workersToResize: [], profilesToCreate: [] });
  });

  test("detects static worker endpoint drift instead of overwriting a provisioned worker", async () => {
    const manifest = await exampleManifest();
    const runtime = await provisionRuntime();
    await provisionManifest(runtime, manifest);

    const conflicting = structuredClone(manifest);
    conflicting.workers[0]!.endpoint = "https://different-worker.internal";

    await expect(provisionManifest(runtime, conflicting)).rejects.toMatchObject({
      code: "conflict",
      status: 409
    });
  });

  test("treats a media playback relay endpoint as immutable worker identity", async () => {
    const manifest = await exampleManifest();
    const runtime = await provisionRuntime();
    const worker = manifest.workers[0]!;
    worker.capabilities = {
      ...worker.capabilities,
      runtimeFamilies: ["media-playback"],
      recipeRefs: ["recipe_media-playback@1" as never],
      // Keep the published fixture's profile valid; media playback itself never acquires it.
      supportedProfileFamilies: ["reporting-reporting", "media"],
    };
    worker.mediaCapacity = 1;
    worker.mediaPlaybackEndpoint = "http://fabric-worker-media:8084";
    await provisionManifest(runtime, manifest);

    const conflicting = structuredClone(manifest);
    conflicting.workers[0]!.mediaPlaybackEndpoint = "http://unexpected-media-worker:8084";
    await expect(provisionManifest(runtime, conflicting)).rejects.toMatchObject({
      code: "conflict",
      status: 409,
    });
  });

  test("does not make omitted principal timestamps part of its static identity", async () => {
    const manifest = await exampleManifest();
    const rawWithoutCreatedAt = structuredClone(manifest) as unknown as Record<string, unknown>;
    delete (rawWithoutCreatedAt.principals as Array<Record<string, unknown>>)[0]!.createdAt;
    const replayable = parseProvisionManifest(rawWithoutCreatedAt);
    const runtime = await provisionRuntime();

    await provisionManifest(runtime, replayable);
    const replay = parseProvisionManifest(rawWithoutCreatedAt);
    expect((await provisionManifest(runtime, replay)).principalsToCreate).toEqual([]);
  });

  test("enables managed interactive capability only as an idle, otherwise identical worker upgrade", async () => {
    const manifest = await exampleManifest();
    const runtime = await provisionRuntime();
    await provisionManifest(runtime, manifest);

    const upgraded = structuredClone(manifest);
    upgraded.workers[0]!.capabilities = { ...upgraded.workers[0]!.capabilities, supportsInteractive: true };

    const plan = await provisionManifest(runtime, upgraded, true);
    expect(plan.workersToEnableInteractive).toEqual([upgraded.workers[0]!.id]);
    await provisionManifest(runtime, upgraded);
    expect((await runtime.scheduler.store.snapshot()).workers.get(upgraded.workers[0]!.id)?.capabilities.supportsInteractive).toBe(true);
    expect((await provisionManifest(runtime, upgraded)).workersToEnableInteractive).toEqual([]);
  });

  test("refuses the managed interactive capability upgrade while the worker owns an active lease", async () => {
    const manifest = await exampleManifest();
    const runtime = await provisionRuntime();
    await provisionManifest(runtime, manifest);
    await holdActiveLease(runtime, manifest, "interactive-upgrade-active-lease");

    const upgraded = structuredClone(manifest);
    upgraded.workers[0]!.capabilities = { ...upgraded.workers[0]!.capabilities, supportsInteractive: true };
    await expect(provisionManifest(runtime, upgraded)).rejects.toMatchObject({ code: "conflict", status: 409 });
  });

  test("migrates only an idle managed worker from the reviewed legacy CDP endpoint", async () => {
    const manifest = await exampleManifest();
    const runtime = await provisionRuntime();
    manifest.workers[0]!.cdpRelayEndpoint = "http://fabric-browser-{leaseId}:9222";
    await provisionManifest(runtime, manifest);

    const upgraded = structuredClone(manifest);
    upgraded.workers[0]!.cdpRelayEndpoint = "http://fabric-browser-{leaseId}:9223";
    expect((await provisionManifest(runtime, upgraded, true)).workersToMigrateCdpBridge).toEqual([upgraded.workers[0]!.id]);
    await provisionManifest(runtime, upgraded);
    expect((await runtime.scheduler.store.snapshot()).workers.get(upgraded.workers[0]!.id)?.cdpRelayEndpoint).toBe("http://fabric-browser-{leaseId}:9223");
  });

  test("refuses the managed CDP bridge migration while the worker owns an active lease", async () => {
    const manifest = await exampleManifest();
    const runtime = await provisionRuntime();
    manifest.workers[0]!.cdpRelayEndpoint = "http://fabric-browser-{leaseId}:9222";
    await provisionManifest(runtime, manifest);
    await holdActiveLease(runtime, manifest, "cdp-bridge-upgrade-active-lease");

    const upgraded = structuredClone(manifest);
    upgraded.workers[0]!.cdpRelayEndpoint = "http://fabric-browser-{leaseId}:9223";
    await expect(provisionManifest(runtime, upgraded)).rejects.toMatchObject({ code: "conflict", status: 409 });
  });

  test("applies the two reviewed managed-worker upgrades together while idle", async () => {
    const manifest = await exampleManifest();
    const runtime = await provisionRuntime();
    manifest.workers[0]!.cdpRelayEndpoint = "http://fabric-browser-{leaseId}:9222";
    manifest.workers[0]!.capabilities = { ...manifest.workers[0]!.capabilities, supportsInteractive: false };
    await provisionManifest(runtime, manifest);

    const upgraded = structuredClone(manifest);
    upgraded.workers[0]!.cdpRelayEndpoint = "http://fabric-browser-{leaseId}:9223";
    upgraded.workers[0]!.capabilities = { ...upgraded.workers[0]!.capabilities, supportsInteractive: true };
    expect(await provisionManifest(runtime, upgraded, true)).toMatchObject({
      workersToEnableInteractive: [upgraded.workers[0]!.id],
      workersToMigrateCdpBridge: [upgraded.workers[0]!.id],
    });
    await provisionManifest(runtime, upgraded);
    const worker = (await runtime.scheduler.store.snapshot()).workers.get(upgraded.workers[0]!.id)!;
    expect(worker.capabilities.supportsInteractive).toBe(true);
    expect(worker.cdpRelayEndpoint).toBe("http://fabric-browser-{leaseId}:9223");
  });

  test("resizes an idle managed worker's capacity and resource limits, idempotently", async () => {
    const manifest = await exampleManifest();
    manifest.workers[0]!.capacity = 1;
    manifest.workers[0]!.resourceLimits = { ...manifest.workers[0]!.resourceLimits, maxBrowserLeases: 1, memoryMiB: 4_096 };
    const runtime = await provisionRuntime();
    await provisionManifest(runtime, manifest);

    const resized = structuredClone(manifest);
    resized.workers[0]!.capacity = 3;
    resized.workers[0]!.resourceLimits = { ...resized.workers[0]!.resourceLimits, maxBrowserLeases: 3, memoryMiB: 2_048 };
    expect((await provisionManifest(runtime, resized, true)).workersToResize).toEqual([resized.workers[0]!.id]);
    await provisionManifest(runtime, resized);
    const state = await runtime.scheduler.store.snapshot();
    const worker = state.workers.get(resized.workers[0]!.id)!;
    expect(worker.capacity).toBe(3);
    expect(worker.resourceLimits).toEqual(resized.workers[0]!.resourceLimits);
    expect([...state.events.values()].find((event) => event.type === "worker.resized")?.payload).toEqual({ previousCapacity: 1, capacity: 3, previousMaxBrowserLeases: 1, maxBrowserLeases: 3 });
    expect((await provisionManifest(runtime, resized)).workersToResize).toEqual([]);

    // Shrinking back is the same reviewed transition.
    expect((await provisionManifest(runtime, manifest)).workersToResize).toEqual([manifest.workers[0]!.id]);
    expect((await runtime.scheduler.store.snapshot()).workers.get(manifest.workers[0]!.id)!.capacity).toBe(1);
  });

  test("refuses a resize while the worker owns an active lease", async () => {
    const manifest = await exampleManifest();
    const runtime = await provisionRuntime();
    await provisionManifest(runtime, manifest);
    await holdActiveLease(runtime, manifest, "resize-active-lease");
    const resized = structuredClone(manifest);
    resized.workers[0]!.capacity = resized.workers[0]!.capacity === 1 ? 2 : 1;
    resized.workers[0]!.resourceLimits = { ...resized.workers[0]!.resourceLimits, maxBrowserLeases: 3 };
    await expect(provisionManifest(runtime, resized)).rejects.toMatchObject({ code: "conflict", status: 409 });
  });

  test("a resize does not smuggle in other worker changes", async () => {
    const manifest = await exampleManifest();
    const runtime = await provisionRuntime();
    await provisionManifest(runtime, manifest);
    const changed = structuredClone(manifest);
    changed.workers[0]!.resourceLimits = { ...changed.workers[0]!.resourceLimits, memoryMiB: changed.workers[0]!.resourceLimits.memoryMiB + 512 };
    changed.workers[0]!.volumeNames = [...changed.workers[0]!.volumeNames, "profile_smuggled"];
    await expect(provisionManifest(runtime, changed)).rejects.toMatchObject({ code: "conflict", status: 409 });
  });

  test("the scheduler bounds a resize and reserves it for fabric admins", async () => {
    const manifest = await exampleManifest();
    const runtime = await provisionRuntime();
    await provisionManifest(runtime, manifest);
    const worker = manifest.workers[0]!;
    const admin = manifest.principals.find((principal) => principal.roles.includes("fabric_admin"))!;
    const operator = { ...admin, id: "principal_operator" as never, roles: ["project_operator" as const], certificateFingerprint: "operator-cert" };
    await runtime.scheduler.registerPrincipal(operator);
    const limits = { ...worker.resourceLimits, maxBrowserLeases: 2 };
    await expect(runtime.scheduler.resizeManagedWorker(worker.id, { capacity: 3, resourceLimits: limits }, admin)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(runtime.scheduler.resizeManagedWorker(worker.id, { capacity: 0, resourceLimits: limits }, admin)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(runtime.scheduler.resizeManagedWorker(worker.id, { capacity: 2, resourceLimits: limits }, operator)).rejects.toMatchObject({ code: "authorization_denied" });
    expect((await runtime.scheduler.resizeManagedWorker(worker.id, { capacity: 2, resourceLimits: limits }, admin)).capacity).toBe(2);
  });
});
