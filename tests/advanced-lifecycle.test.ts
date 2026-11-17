import { describe, expect, test } from "bun:test";
import { AssignmentSigner, BrowserScheduler, FakeClock, ProfileVolumeManager, MemoryVolumeDriver, WebhookCallbackDispatcher, CallbackQueue } from "@browser-fabric/control-plane";
import { builtInEgressPolicies, ChallengeCoordinator } from "@browser-fabric/policy";
import { RecipeRegistry } from "@browser-fabric/recipes";
import { TEST_PRINCIPAL, TEST_PROJECT, bootstrapTestScheduler, makeWorker, exampleCatalog } from "@browser-fabric/testkit";
import type { JobId, Worker } from "@browser-fabric/contracts";

describe("advanced lifecycle boundaries", () => {
  test("assignment envelopes are signed and addressed to one worker", async () => {
    const signer = AssignmentSigner.generate();
    const assignment = { recipe: {} as never, egressPolicy: {} as never, artifactPolicy: {} as never };
    const envelope = signer.issue("worker_a" as Worker["id"], assignment);
    expect(signer.verifier().verify(envelope, "worker_a" as Worker["id"])).toEqual(assignment);
    expect(() => signer.verifier().verify({ ...envelope, workerId: "worker_b" as Worker["id"] }, "worker_a" as Worker["id"])).toThrow();
    expect(() => signer.verifier().verify({ ...envelope, signature: `${envelope.signature}x` }, "worker_a" as Worker["id"])).toThrow();
  });

  test("profile volume relocation copies and verifies before changing affinity", async () => {
    const context = await bootstrapTestScheduler();
    const target = makeWorker({ id: "worker_target" as Worker["id"], volumeNames: ["profile-volume-g2"], capabilities: context.worker.capabilities });
    await context.scheduler.registerWorker(target);
    const driver = new MemoryVolumeDriver();
    driver.seed(context.worker, context.profile.volumeName, new TextEncoder().encode("profile-state"));
    const manager = new ProfileVolumeManager({ scheduler: context.scheduler, driver });
    const relocated = await manager.relocateProfile(context.profile.ref, target, TEST_PRINCIPAL);
    expect(relocated.workerId).toBe(target.id);
    expect(relocated.volumeGeneration).toBe(2);
    expect((await driver.inspect(target, "profile-volume-g2")).exists).toBe(true);
  });

  test("challenge coordinator does not invent handlers and preserves manual handoff", async () => {
    const coordinator = new ChallengeCoordinator({
      automatic: async () => "solved",
      fallback: async () => "blocked_challenge",
      manual: async () => "expired"
    });
    const registry = await import("@browser-fabric/policy");
    const manualSet = registry.builtInChallengeSets.find((set) => set.family === "manual-handoff")!;
    const manual = await coordinator.run(manualSet, "manual-handoff", { sessionId: "session", project: "project", signal: new AbortController().signal });
    expect(manual.status).toBe("awaiting_manual");
    const unknown = await coordinator.run(manualSet, "dbc", { sessionId: "session", project: "project" });
    expect(unknown.status).toBe("blocked_challenge");
  });

  test("callback dispatcher signs payloads, retries transient failures, and never sends secrets in body", async () => {
    const calls: { headers: Record<string, string>; body: string }[] = [];
    let count = 0;
    const dispatcher = new WebhookCallbackDispatcher({
      maxAttempts: 3,
      transport: { send: async (input) => { calls.push({ headers: input.headers, body: input.body }); count += 1; return { status: count < 2 ? 503 : 204 }; } }
    });
    const result = await dispatcher.deliver({ url: "https://app.example/hooks", secret: "0123456789012345", request: { job: { id: "job_1" as JobId, project: TEST_PROJECT, status: "succeeded", result: { ok: true }, updatedAt: new Date().toISOString() }, attempt: 1 } });
    expect(result.delivered).toBe(true);
    expect(result.attempts).toBe(2);
    expect(calls[0]?.headers["x-fabric-event-signature"]).toMatch(/^v1=/);
    expect(calls[0]?.body).not.toContain("password");
  });
});

test("ephemeral input envelopes keep plaintext out of relay memory and decrypt once at the worker", async () => {
  const { generateWorkerInputKeyPair, encryptEphemeralInput, decryptEphemeralInput, EncryptedEphemeralInputInbox } = await import("@browser-fabric/control-plane");
  const keys = generateWorkerInputKeyPair(2048);
  const request = { id: "input-request_e2e" as never, project: TEST_PROJECT, sessionId: "browser-session_e2e" as never, leaseId: "browser-lease_e2e" as never, field: "password", fieldType: "password" as const, status: "pending" as const, expiresAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" };
  const envelope = encryptEphemeralInput({ request, workerId: "worker_e2e" as never, workerPublicKeyPem: keys.publicKeyPem, value: "plaintext-never-relayed" });
  expect(JSON.stringify(envelope)).not.toContain("plaintext-never-relayed");
  const inbox = new EncryptedEphemeralInputInbox();
  inbox.offer(envelope, request);
  expect(inbox.has(request.id)).toBe(true);
  expect(inbox.take(request, "worker_e2e" as never, keys.privateKeyPem, new Date("2026-01-01T00:00:00.000Z"))).toBe("plaintext-never-relayed");
  expect(inbox.has(request.id)).toBe(false);
  expect(() => inbox.take(request, "worker_e2e" as never, keys.privateKeyPem)).toThrow();
  const wrongKeys = generateWorkerInputKeyPair(2048);
  const second = encryptEphemeralInput({ request: { ...request, id: "input-request_wrong" as never }, workerId: "worker_e2e" as never, workerPublicKeyPem: keys.publicKeyPem, value: "secret" });
  expect(() => decryptEphemeralInput(second, wrongKeys.privateKeyPem, { requestId: second.requestId, workerId: "worker_e2e" as never, now: new Date("2026-01-01T00:00:00.000Z") })).toThrow();
});

test("scheduler accepts ciphertext-only input envelopes and returns no plaintext", async () => {
  const { EncryptedInputRouter, generateWorkerInputKeyPair, encryptEphemeralInput, BrowserScheduler, CapabilitySigner, FakeClock, InMemoryFabricStore } = await import("@browser-fabric/control-plane");
  const { makeWorker, makeProfile } = await import("@browser-fabric/testkit");
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const router = new EncryptedInputRouter();
  const keys = generateWorkerInputKeyPair(2048);
  const worker = makeWorker({ id: "worker_encrypted" as never, inputEncryptionPublicKeyPem: keys.publicKeyPem });
  const scheduler = new BrowserScheduler({ store: new InMemoryFabricStore(), clock, ephemeralInputVault: router, capabilitySigner: new CapabilitySigner({ secret: "01234567890123456789012345678901", clock, gatewayBaseUrl: "wss://fabric.test" }) });
  await scheduler.bootstrap({ projects: [{ id: TEST_PROJECT, name: "Test" }], principals: [TEST_PRINCIPAL] });
  await scheduler.registerWorker(worker);
  const profile = await scheduler.createProfile(makeProfile(worker), TEST_PRINCIPAL);
  const session = await scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "encrypted-input", runtime: "rebrowser-puppeteer", browserRecipeRef: "recipe_rebrowser-puppeteer@1" as never, profileRef: profile.ref, leaseMode: "writer", egressPolicyRef: "egress_direct@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL);
  const [assignment] = await scheduler.dispatch();
  const request = await scheduler.requestEphemeralInput({ sessionId: session.id as never, leaseId: assignment!.lease!.id, field: "password", fieldType: "password" }, { ...TEST_PRINCIPAL, certificateFingerprint: worker.certificateFingerprint });
  const envelope = encryptEphemeralInput({ request: request.request, workerId: worker.id, workerPublicKeyPem: keys.publicKeyPem, value: "ciphertext-only-secret", now: clock.now() });
  const accepted = await scheduler.provideEncryptedEphemeralInput(request.request.id, envelope, TEST_PRINCIPAL);
  expect(JSON.stringify(accepted)).not.toContain("ciphertext-only-secret");
  const returned = await scheduler.takeEncryptedEphemeralInput(request.request.id, worker.id, { ...TEST_PRINCIPAL, certificateFingerprint: worker.certificateFingerprint });
  expect(returned.ciphertext).toBe(envelope.ciphertext);
  expect(JSON.stringify(await scheduler.store.snapshot())).not.toContain("ciphertext-only-secret");
});

test("encrypted input broker is transient, authenticated, idempotent, and one-shot", async () => {
  const { MemoryEncryptedInputBroker } = await import("@browser-fabric/control-plane");
  const { createInputBrokerFetch } = await import("../apps/input-broker/src/index");
  const broker = new MemoryEncryptedInputBroker();
  const fetchBroker = createInputBrokerFetch({ broker });
  const envelope = {
    version: 1 as const,
    algorithm: "rsa-oaep-sha256+a256gcm" as const,
    requestId: "input-request_broker" as never,
    workerId: "worker_broker" as never,
    expiresAt: "2099-01-01T00:00:00.000Z",
    wrappedKey: "wrapped",
    iv: "iv",
    tag: "tag",
    ciphertext: "ciphertext"
  };
  const unauth = await fetchBroker(new Request("https://broker/v1/input-envelopes/input-request_broker", { method: "POST", body: JSON.stringify(envelope) }));
  expect(unauth.status).toBe(401);
  const headers = { "content-type": "application/json", "x-fabric-mtls-verified": "true", "x-fabric-service": "fabric-api" };
  const put = await fetchBroker(new Request("https://broker/v1/input-envelopes/input-request_broker", { method: "POST", headers, body: JSON.stringify(envelope) }));
  expect(put.status).toBe(202);
  const replay = await fetchBroker(new Request("https://broker/v1/input-envelopes/input-request_broker", { method: "POST", headers, body: JSON.stringify(envelope) }));
  expect(replay.status).toBe(202);
  const get = await fetchBroker(new Request("https://broker/v1/input-envelopes/input-request_broker?workerId=worker_broker", { headers: { "x-fabric-mtls-verified": "true", "x-fabric-service": "fabric-worker-manager" } }));
  expect(get.status).toBe(200);
  expect(await get.json()).toEqual(envelope);
  const secondGet = await fetchBroker(new Request("https://broker/v1/input-envelopes/input-request_broker?workerId=worker_broker", { headers: { "x-fabric-mtls-verified": "true", "x-fabric-service": "fabric-worker-manager" } }));
  expect(secondGet.status).toBe(404);
});

test("typed recipe runner preserves retry, input, artifact, and normalized terminal state", async () => {
  const { RecipeRunner, RecipeRegistry, builtInRecipes } = await import("@browser-fabric/recipes");
  const { ArtifactCollector, MemoryObjectStore } = await import("@browser-fabric/control-plane");
  const context = await bootstrapTestScheduler();
  const fetchProfile = await context.scheduler.createProfile({ ...context.profile, ref: "profile_runner_fetch" as never, profileFamily: "default" }, TEST_PRINCIPAL);
  const job = await context.scheduler.createJob({ project: TEST_PROJECT, idempotencyKey: "runner-job", recipeRef: "recipe_example-fetch@1" as never, operation: { operation: "fetch_page", url: "https://site.example" }, profileRef: fetchProfile.ref, egressPolicyRef: "egress_direct@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never }, TEST_PRINCIPAL);
  const [assignment] = await context.scheduler.dispatch();
  const attempts: number[] = [];
  const runner = new RecipeRunner({
    scheduler: context.scheduler,
    registry: new RecipeRegistry([...builtInRecipes, ...exampleCatalog.recipes]),
    artifactCollector: new ArtifactCollector({ scheduler: context.scheduler, objectStore: new MemoryObjectStore(), clock: () => context.clock.now() }),
    executorFor: () => ({ execute: async ({ job: current }) => {
      attempts.push(attempts.length + 1);
      if (attempts.length === 1) return { status: "failed", reason: "temporary network", retryable: true };
      return { status: "succeeded", result: { articleCount: 1 }, artifacts: [{ kind: "screenshot", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]) }] };
    } })
  });
  const result = await runner.run(job.id as never, context.worker, TEST_PRINCIPAL);
  expect(result.status).toBe("succeeded");
  expect(attempts).toEqual([1, 2]);
  expect((await context.scheduler.getJob(job.id as never, TEST_PRINCIPAL)).status).toBe("succeeded");
  expect((await context.store.snapshot()).artifacts.size).toBe(1);
  expect(assignment?.lease).toBeDefined();
});
