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
    egressPolicyRef: "egress_direct@1" as never,
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
      workersToReconfigure: [],
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
    expect(snapshot.projects.get(manifest.projects[0]!.id)?.name).toBe("Default");
    expect(snapshot.principals.get(manifest.principals[0]!.id)?.roles).toContain("fabric_admin");
    expect(snapshot.workers.get(manifest.workers[0]!.id)?.volumeNames).toContain(manifest.profiles[0]!.volumeName);
    expect(snapshot.profiles.get(manifest.profiles[0]!.ref)?.workerId).toBe(manifest.workers[0]!.id);

    const replay = await provisionManifest(runtime, manifest);
    expect(replay).toEqual({ projectsToCreate: [], principalsToCreate: [], workersToCreate: [], workersToReconfigure: [], profilesToCreate: [] });
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

  test("never upgrades a provisioned worker's runtimes, interactivity or endpoints", async () => {
    const manifest = await exampleManifest();
    const runtime = await provisionRuntime();
    await provisionManifest(runtime, manifest);
    for (const mutate of [
      (worker: ProvisionManifest["workers"][number]) => { worker.capabilities = { ...worker.capabilities, supportsInteractive: !worker.capabilities.supportsInteractive }; },
      (worker: ProvisionManifest["workers"][number]) => { worker.capabilities = { ...worker.capabilities, runtimeFamilies: [] }; },
      (worker: ProvisionManifest["workers"][number]) => { worker.cdpRelayEndpoint = "http://fabric-browser-{leaseId}:9222"; },
    ]) {
      const changed = structuredClone(manifest);
      mutate(changed.workers[0]!);
      await expect(provisionManifest(runtime, changed)).rejects.toMatchObject({ code: "conflict", status: 409 });
    }
  });

  test("enables a catalog recipe and its profile family on an idle provisioned worker", async () => {
    const manifest = await exampleManifest();
    const runtime = await provisionRuntime();
    await provisionManifest(runtime, manifest);
    const extended = structuredClone(manifest);
    const worker = extended.workers[0]!;
    worker.capabilities = {
      ...worker.capabilities,
      recipeRefs: [...worker.capabilities.recipeRefs, "recipe_example-fetch@1" as never],
      supportedProfileFamilies: [...worker.capabilities.supportedProfileFamilies, "research"],
    };
    expect((await provisionManifest(runtime, extended, true)).workersToReconfigure).toEqual([worker.id]);
    await provisionManifest(runtime, extended);
    const stored = (await runtime.scheduler.store.snapshot()).workers.get(worker.id)!;
    expect(stored.capabilities.recipeRefs).toContain("recipe_example-fetch@1" as never);
    expect(stored.capabilities.supportedProfileFamilies).toContain("research");
    expect((await provisionManifest(runtime, extended)).workersToReconfigure).toEqual([]);
    // Removing it again is the same reviewed transition.
    expect((await provisionManifest(runtime, manifest)).workersToReconfigure).toEqual([worker.id]);
  });

  test("reconfigures an idle managed worker's capacity and resource limits, idempotently", async () => {
    const manifest = await exampleManifest();
    manifest.workers[0]!.capacity = 1;
    manifest.workers[0]!.resourceLimits = { ...manifest.workers[0]!.resourceLimits, maxBrowserLeases: 1, memoryMiB: 4_096 };
    const runtime = await provisionRuntime();
    await provisionManifest(runtime, manifest);

    const resized = structuredClone(manifest);
    resized.workers[0]!.capacity = 3;
    resized.workers[0]!.resourceLimits = { ...resized.workers[0]!.resourceLimits, maxBrowserLeases: 3, memoryMiB: 2_048 };
    expect((await provisionManifest(runtime, resized, true)).workersToReconfigure).toEqual([resized.workers[0]!.id]);
    await provisionManifest(runtime, resized);
    const state = await runtime.scheduler.store.snapshot();
    const worker = state.workers.get(resized.workers[0]!.id)!;
    expect(worker.capacity).toBe(3);
    expect(worker.resourceLimits).toEqual(resized.workers[0]!.resourceLimits);
    expect([...state.events.values()].find((event) => event.type === "worker.reconfigured")?.payload).toEqual({ previousCapacity: 1, capacity: 3, previousMaxBrowserLeases: 1, maxBrowserLeases: 3, recipes: 2, profileFamilies: 1 });
    expect((await provisionManifest(runtime, resized)).workersToReconfigure).toEqual([]);

    // Shrinking back is the same reviewed transition.
    expect((await provisionManifest(runtime, manifest)).workersToReconfigure).toEqual([manifest.workers[0]!.id]);
    expect((await runtime.scheduler.store.snapshot()).workers.get(manifest.workers[0]!.id)!.capacity).toBe(1);
  });

  test("refuses a reconfiguration while the worker owns an active lease", async () => {
    const manifest = await exampleManifest();
    const runtime = await provisionRuntime();
    await provisionManifest(runtime, manifest);
    await holdActiveLease(runtime, manifest, "resize-active-lease");
    const resized = structuredClone(manifest);
    resized.workers[0]!.capacity = resized.workers[0]!.capacity === 1 ? 2 : 1;
    resized.workers[0]!.resourceLimits = { ...resized.workers[0]!.resourceLimits, maxBrowserLeases: 3 };
    await expect(provisionManifest(runtime, resized)).rejects.toMatchObject({ code: "conflict", status: 409 });
  });

  test("a reconfiguration does not smuggle in other worker changes", async () => {
    const manifest = await exampleManifest();
    const runtime = await provisionRuntime();
    await provisionManifest(runtime, manifest);
    const changed = structuredClone(manifest);
    changed.workers[0]!.resourceLimits = { ...changed.workers[0]!.resourceLimits, memoryMiB: changed.workers[0]!.resourceLimits.memoryMiB + 512 };
    changed.workers[0]!.volumeNames = [...changed.workers[0]!.volumeNames, "profile_smuggled"];
    await expect(provisionManifest(runtime, changed)).rejects.toMatchObject({ code: "conflict", status: 409 });
  });

  test("the scheduler bounds a reconfiguration and reserves it for fabric admins", async () => {
    const manifest = await exampleManifest();
    const runtime = await provisionRuntime();
    await provisionManifest(runtime, manifest);
    const worker = manifest.workers[0]!;
    const admin = manifest.principals.find((principal) => principal.roles.includes("fabric_admin"))!;
    const operator = { ...admin, id: "principal_operator" as never, roles: ["project_operator" as const], certificateFingerprint: "operator-cert" };
    await runtime.scheduler.registerPrincipal(operator);
    const limits = { ...worker.resourceLimits, maxBrowserLeases: 2 };
    const change = (capacity: number, extra: Partial<{ recipeRefs: string[]; supportedProfileFamilies: string[] }> = {}) => ({
      capacity,
      resourceLimits: limits,
      recipeRefs: (extra.recipeRefs ?? worker.capabilities.recipeRefs) as never,
      supportedProfileFamilies: extra.supportedProfileFamilies ?? worker.capabilities.supportedProfileFamilies,
    });
    await expect(runtime.scheduler.reconfigureManagedWorker(worker.id, change(3), admin)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(runtime.scheduler.reconfigureManagedWorker(worker.id, change(5), admin)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(runtime.scheduler.reconfigureManagedWorker(worker.id, change(2, { recipeRefs: ["not-a-recipe"] }), admin)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(runtime.scheduler.reconfigureManagedWorker(worker.id, change(2, { supportedProfileFamilies: ["default", "default"] }), admin)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(runtime.scheduler.reconfigureManagedWorker(worker.id, change(2), operator)).rejects.toMatchObject({ code: "authorization_denied" });
    expect((await runtime.scheduler.reconfigureManagedWorker(worker.id, change(2), admin)).capacity).toBe(2);
    expect((await runtime.scheduler.reconfigureManagedWorker(worker.id, change(0), admin)).capacity).toBe(0);
  });
});
