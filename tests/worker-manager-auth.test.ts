import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createWorkerManagerFetch } from "../apps/worker-manager/src/server";
import { AssignmentSigner, workerEnrollmentTokenHash } from "@browser-fabric/control-plane";
import { TEST_PRINCIPAL, TEST_PROJECT, createTestScheduler, makeWorker } from "@browser-fabric/testkit";

function headers(worker: { certificateFingerprint: string }, enrollment?: string): Headers {
  return new Headers({
    "x-fabric-mtls-verified": "true",
    "x-fabric-worker-cert-fingerprint": worker.certificateFingerprint,
    ...(enrollment === undefined ? {} : { "x-fabric-worker-enrollment": enrollment }),
  });
}

describe("worker-manager control authentication", () => {
  test("accepts a structurally identical worker registration when object key order changes", async () => {
    const { scheduler } = createTestScheduler();
    await scheduler.bootstrap({ projects: [{ id: TEST_PROJECT, name: "Test" }], principals: [TEST_PRINCIPAL] });
    const enrollment = "worker-registration-ordering-token-at-least-24-bytes";
    const worker = makeWorker({ id: "worker_registration_order" as never, enrollmentTokenHash: workerEnrollmentTokenHash(enrollment) });
    await scheduler.registerWorker(worker, TEST_PRINCIPAL);

    const advertised = {
      id: worker.id,
      certificateFingerprint: worker.certificateFingerprint,
      endpoint: worker.endpoint,
      cdpRelayEndpoint: worker.cdpRelayEndpoint,
      ...(worker.mediaPlaybackEndpoint === undefined ? {} : { mediaPlaybackEndpoint: worker.mediaPlaybackEndpoint }),
      capabilities: {
        supportsCompanionCompanion: worker.capabilities.supportsCompanionCompanion,
        supportedProfileFamilies: worker.capabilities.supportedProfileFamilies,
        browserVersions: worker.capabilities.browserVersions,
        recipeRefs: worker.capabilities.recipeRefs,
        supportsInteractive: worker.capabilities.supportsInteractive,
        runtimeFamilies: worker.capabilities.runtimeFamilies,
      },
      capacity: worker.capacity,
      mediaCapacity: worker.mediaCapacity,
      health: worker.health,
      isLocal: worker.isLocal,
      volumeNames: worker.volumeNames,
      resourceLimits: {
        temporaryStorageMiB: worker.resourceLimits.temporaryStorageMiB,
        shmMiB: worker.resourceLimits.shmMiB,
        pids: worker.resourceLimits.pids,
        memoryMiB: worker.resourceLimits.memoryMiB,
        cpuMilli: worker.resourceLimits.cpuMilli,
        maxBrowserLeases: worker.resourceLimits.maxBrowserLeases,
      },
    };

    await expect(
      scheduler.refreshWorkerRegistration(advertised, worker.certificateFingerprint, enrollment),
    ).resolves.toMatchObject({ id: worker.id, health: "healthy" });
  });

  test("requires the worker-specific enrollment secret on every control route", async () => {
    const { scheduler } = createTestScheduler();
    await scheduler.bootstrap({ projects: [{ id: TEST_PROJECT, name: "Test" }], principals: [TEST_PRINCIPAL] });
    const enrollment = "worker-control-enrollment-token-at-least-24-bytes";
    const worker = makeWorker({ id: "worker_control" as never, enrollmentTokenHash: workerEnrollmentTokenHash(enrollment) });
    await scheduler.registerWorker(worker, TEST_PRINCIPAL);
    const { privateKey } = generateKeyPairSync("ed25519");
    const fetchManager = createWorkerManagerFetch({ scheduler, assignmentSigner: new AssignmentSigner(privateKey.export({ format: "pem", type: "pkcs8" }).toString()) });

    const missing = await fetchManager(new Request(`https://manager/v1/workers/${worker.id}/heartbeat`, { method: "POST", headers: headers(worker) }));
    expect(missing.status).toBe(401);

    const wrong = await fetchManager(new Request(`https://manager/v1/workers/${worker.id}/heartbeat`, { method: "POST", headers: headers(worker, "another-worker-enrollment-token-at-least-24") }));
    expect(wrong.status).toBe(401);

    const accepted = await fetchManager(new Request(`https://manager/v1/workers/${worker.id}/heartbeat`, { method: "POST", headers: headers(worker, enrollment) }));
    expect(accepted.status).toBe(200);
  });

  test("a different provisioned worker cannot use its token to impersonate the target worker", async () => {
    const { scheduler } = createTestScheduler();
    await scheduler.bootstrap({ projects: [{ id: TEST_PROJECT, name: "Test" }], principals: [TEST_PRINCIPAL] });
    const targetEnrollment = "target-worker-enrollment-token-at-least-24-bytes";
    const attackerEnrollment = "attacker-worker-enrollment-token-at-least-24";
    const target = makeWorker({ id: "worker_target" as never, enrollmentTokenHash: workerEnrollmentTokenHash(targetEnrollment) });
    const attacker = makeWorker({ id: "worker_attacker" as never, enrollmentTokenHash: workerEnrollmentTokenHash(attackerEnrollment) });
    await scheduler.registerWorker(target, TEST_PRINCIPAL);
    await scheduler.registerWorker(attacker, TEST_PRINCIPAL);
    const { privateKey } = generateKeyPairSync("ed25519");
    const fetchManager = createWorkerManagerFetch({ scheduler, assignmentSigner: new AssignmentSigner(privateKey.export({ format: "pem", type: "pkcs8" }).toString()) });

    // Even when a caller copies the target fingerprint header, the target enrollment proof is
    // required. A valid certificate/token for another worker is insufficient.
    const impersonation = await fetchManager(new Request(`https://manager/v1/workers/${target.id}/heartbeat`, { method: "POST", headers: headers(target, attackerEnrollment) }));
    expect(impersonation.status).toBe(401);
  });
});
