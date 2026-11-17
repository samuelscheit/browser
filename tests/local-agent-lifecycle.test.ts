import { describe, expect, test } from "bun:test";
import type { Worker, WorkerAssignment } from "@browser-fabric/contracts";
import { FabricWorkerAgent, type CdpRelayHandle, type LocalAgentTransport } from "../apps/local-agent/src";
import { TEST_PROJECT, TEST_PRINCIPAL, bootstrapTestScheduler, makeWorker } from "@browser-fabric/testkit";

function fakeAssignment(worker: Worker, leaseId: string): WorkerAssignment {
  return {
    lease: {
      id: leaseId as never,
      sessionId: "browser-session_local" as never,
      project: TEST_PROJECT,
      workerId: worker.id,
      mode: "interactive",
      status: "active",
      expiresAt: "2099-01-01T00:00:00.000Z",
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      internalCdpEndpoint: "reverse://worker_local/browser-lease_local",
      profileRef: "profile_local_interactive" as never,
    },
    session: {
      id: "browser-session_local" as never,
      project: TEST_PROJECT,
      idempotencyKey: "local",
      runtime: "chrome",
      browserRecipeRef: "recipe_chrome@1" as never,
      leaseMode: "interactive",
      egressPolicyRef: "egress_direct@1" as never,
      artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
      metadata: {},
      status: "allocating",
      workerId: worker.id,
      leaseId: leaseId as never,
      externalConnectionCount: 0,
      expiresAt: "2099-01-01T00:00:00.000Z",
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    recipe: {
      ref: "recipe_chrome@1" as never,
      family: "chrome",
      version: 1,
      runtime: "chrome",
      immutableHash: "sha256:test",
      browserImage: "registry.example/chromium@sha256:" + "a".repeat(64),
      browserVersion: "test",
      mode: "interactive",
      profileFamily: "default",
      requiredCapabilities: [],
      launch: { viewport: { width: 1440, height: 1024 }, locale: "en-US", timezone: "UTC", launchFlags: [], extensions: [], initScripts: [], sharedMemoryMiB: 512, downloadsEnabled: true },
      artifactDefaults: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    profile: {
      ref: "profile_local_interactive" as never,
      ownerProject: TEST_PROJECT,
      grants: [TEST_PROJECT],
      workerId: worker.id,
      volumeName: "profile-volume",
      profileFamily: "default",
      volumeGeneration: 1,
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    egressPolicy: {
      ref: "egress_direct@1" as never,
      family: "direct",
      version: 1,
      immutableHash: "sha256:test",
      routes: {},
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    artifactPolicy: { ref: "artifact-policy_standard-30-days@1" as never, retentionDays: 30, allowedKinds: ["screenshot"], createdAt: "2026-01-01T00:00:00.000Z" },
  };
}

test("local agent starts the reverse relay before publishing readiness and tears it down first", async () => {
  const worker = makeWorker({ id: "worker_local" as never, isLocal: true, capacity: 1, volumeNames: ["profile-volume"], capabilities: { ...makeWorker().capabilities, supportsInteractive: true, supportedProfileFamilies: ["interactive"], recipeRefs: ["recipe_chrome@1" as never], runtimeFamilies: ["chrome"] } });
  const assignment = fakeAssignment(worker, "browser-lease_local");
  const events: string[] = [];
  const relay: CdpRelayHandle = { connected: true, stop: async () => { events.push("relay-stop"); } };
  const transport: LocalAgentTransport = {
    register: async () => { events.push("register"); },
    heartbeat: async () => { events.push("heartbeat"); },
    activeAssignments: async () => [],
    nextAssignments: async () => events.includes("started") ? [] : [assignment],
    claimAssignment: async () => { events.push("claim"); return assignment; },
    openCdpRelay: async (_workerId, _leaseId, endpoint) => { events.push(`relay-start:${endpoint}`); return relay; },
    markLeaseStarted: async () => { events.push("started"); },
  };
  const executor = {
    start: async () => { events.push("browser-start"); return { processId: "browser-process", cdpBrowserEndpoint: "ws://127.0.0.1:9222/devtools/browser/test" }; },
    stop: async () => { events.push("browser-stop"); },
  };
  const agent = new FabricWorkerAgent({ worker, transport, executor, pollIntervalMs: 30_000 });
  await agent.start();
  expect(events.slice(0, 6)).toEqual(["register", "heartbeat", "claim", "browser-start", "relay-start:ws://127.0.0.1:9222/devtools/browser/test", "started"]);
  await agent.stop();
  expect(events.slice(-2)).toEqual(["relay-stop", "browser-stop"]);
});

test("local agent stops the browser when reverse relay startup fails", async () => {
  const worker = makeWorker({ id: "worker_local_2" as never, isLocal: true, capacity: 1, volumeNames: ["profile-volume"], capabilities: { ...makeWorker().capabilities, supportsInteractive: true, supportedProfileFamilies: ["interactive"], recipeRefs: ["recipe_chrome@1" as never], runtimeFamilies: ["chrome"] } });
  const assignment = fakeAssignment(worker, "browser-lease_local_2");
  const events: string[] = [];
  const transport: LocalAgentTransport = {
    register: async () => {}, heartbeat: async () => {}, activeAssignments: async () => [], nextAssignments: async () => [assignment], claimAssignment: async () => assignment,
    openCdpRelay: async () => { events.push("relay"); throw new Error("relay unavailable"); },
  };
  const executor = { start: async () => { events.push("start"); return { processId: "p", cdpBrowserEndpoint: "ws://browser" }; }, stop: async () => { events.push("stop"); } };
  const agent = new FabricWorkerAgent({ worker, transport, executor, pollIntervalMs: 30_000 });
  await agent.start();
  expect(events).toEqual(["start", "relay", "stop"]);
  await agent.stop();
});

test("local agent fails closed when no outbound relay is configured", async () => {
  const worker = makeWorker({ id: "worker_local_3" as never, isLocal: true, capacity: 1, volumeNames: ["profile-volume"], capabilities: { ...makeWorker().capabilities, supportsInteractive: true, supportedProfileFamilies: ["interactive"], recipeRefs: ["recipe_chrome@1" as never], runtimeFamilies: ["chrome"] } });
  const assignment = fakeAssignment(worker, "browser-lease_local_3");
  const events: string[] = [];
  const transport: LocalAgentTransport = { register: async () => {}, heartbeat: async () => {}, activeAssignments: async () => [], nextAssignments: async () => [assignment], claimAssignment: async () => assignment };
  const executor = { start: async () => { events.push("start"); return { processId: "p", cdpBrowserEndpoint: "ws://browser" }; }, stop: async () => { events.push("stop"); } };
  const agent = new FabricWorkerAgent({ worker, transport, executor, pollIntervalMs: 30_000 });
  await agent.start();
  expect(events).toEqual(["start", "stop"]);
  await agent.stop();
});
