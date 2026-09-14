import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { FabricError } from "@browser-fabric/contracts";
import { createTestScheduler } from "@browser-fabric/testkit";
import { parseProvisionManifest, provisionManifest, type ProvisionManifest } from "../scripts/provision-fabric";

const exampleManifestPath = new URL("../deploy/compose/provision-manifest.example.json", import.meta.url);

async function exampleManifest(): Promise<ProvisionManifest> {
  return parseProvisionManifest(JSON.parse(await readFile(exampleManifestPath, "utf8")));
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
    expect(replay).toEqual({ projectsToCreate: [], principalsToCreate: [], workersToCreate: [], profilesToCreate: [] });
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
});
