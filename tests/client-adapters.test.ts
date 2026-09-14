import { describe, expect, test } from "bun:test";
import { BrowserFabricClient, encryptInputForWorker, type FabricClientOptions } from "@browser-fabric/client";
import { buildWorkloadJob, buildWorkloadSession, workloadOperations } from "@browser-fabric/client";
import { FabricError } from "@browser-fabric/contracts";
import { generateWorkerInputKeyPair, decryptEphemeralInput } from "@browser-fabric/control-plane";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clientWith(handler: (request: Request) => Response | Promise<Response>): { client: BrowserFabricClient; requests: Request[] } {
  const requests: Request[] = [];
  const options: FabricClientOptions = {
    baseUrl: "https://fabric.example/v1/",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return handler(request);
    },
  };
  return { client: new BrowserFabricClient(options), requests };
}

describe("Fabric application client lifecycle", () => {
  test("polls queued sessions, URL-encodes opaque ids, and returns the browser endpoint", async () => {
    let reads = 0;
    const { client, requests } = clientWith((request) => {
      if (request.method === "POST") {
        return jsonResponse({ id: "browser-session_test/1", status: "queued", expiresAt: "2099-01-01T00:00:00Z" }, 201);
      }
      reads += 1;
      return jsonResponse(reads === 1
        ? { id: "browser-session_test/1", status: "allocating", expiresAt: "2099-01-01T00:00:00Z" }
        : { id: "browser-session_test/1", status: "ready", cdpEndpoint: "wss://fabric.example/cdp/cap", expiresAt: "2099-01-01T00:00:00Z" });
    });
    const created = await client.browserSessions.create({
      project: "project_test" as never,
      idempotencyKey: "session-1",
      runtime: "chromium-cdp",
      browserRecipeRef: "recipe_interactive-chromium@1" as never,
      leaseMode: "interactive",
      egressPolicyRef: "egress_direct-egress@1" as never,
      artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
      ttlSeconds: 60,
    });
    const ready = await client.waitForBrowserSession(created.id, { pollIntervalMs: 1, maxPollIntervalMs: 2 });
    expect(ready.cdpEndpoint).toBe("wss://fabric.example/cdp/cap");
    expect(requests.map((request) => request.url)).toEqual([
      "https://fabric.example/v1/browser-sessions",
      "https://fabric.example/v1/browser-sessions/browser-session_test%2F1",
      "https://fabric.example/v1/browser-sessions/browser-session_test%2F1",
    ]);
  });

  test("withBrowserSession cancels and releases a created session when user code fails", async () => {
    const calls: string[] = [];
    const { client } = clientWith((request) => {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (request.method === "POST" && path.endsWith("/browser-sessions")) return jsonResponse({ id: "browser-session_1", status: "queued", expiresAt: "2099-01-01T00:00:00Z" }, 201);
      if (request.method === "GET") return jsonResponse({ id: "browser-session_1", status: "ready", cdpEndpoint: "wss://endpoint", expiresAt: "2099-01-01T00:00:00Z" });
      if (path.endsWith("/cancel")) return jsonResponse({ id: "browser-session_1", status: "cancelled", expiresAt: "2099-01-01T00:00:00Z" });
      return jsonResponse({ id: "browser-session_1", status: "released", expiresAt: "2099-01-01T00:00:00Z" });
    });
    await expect(client.withBrowserSession({
      project: "project_test" as never,
      idempotencyKey: "session-2",
      runtime: "chromium-cdp",
      browserRecipeRef: "recipe_interactive-chromium@1" as never,
      leaseMode: "interactive",
      egressPolicyRef: "egress_direct-egress@1" as never,
      artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
      ttlSeconds: 60,
    }, async () => { throw new Error("workflow failed"); }, { pollIntervalMs: 1 })).rejects.toThrow("workflow failed");
    expect(calls).toEqual([
      "POST /v1/browser-sessions",
      "GET /v1/browser-sessions/browser-session_1",
      "POST /v1/browser-sessions/browser-session_1/cancel",
    ]);
  });

  test("acquireBrowserSession returns a lease handle with explicit heartbeat and release", async () => {
    const calls: string[] = [];
    const { client } = clientWith((request) => {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (request.method === "POST" && path.endsWith("/browser-sessions")) return jsonResponse({ id: "browser-session_handle", status: "queued", expiresAt: "2099-01-01T00:00:00Z" }, 201);
      if (request.method === "GET") return jsonResponse({ id: "browser-session_handle", status: "ready", cdpEndpoint: "wss://endpoint", expiresAt: "2099-01-01T00:00:00Z" });
      if (path.endsWith("/heartbeat")) return jsonResponse({ id: "browser-session_handle", status: "active", cdpEndpoint: "wss://endpoint", expiresAt: "2099-01-01T00:00:00Z" });
      return jsonResponse({ id: "browser-session_handle", status: "released", expiresAt: "2099-01-01T00:00:00Z" });
    });
    const handle = await client.acquireBrowserSession({ project: "project_test" as never, idempotencyKey: "handle-1", runtime: "chromium-cdp", browserRecipeRef: "recipe_interactive-chromium@1" as never, leaseMode: "interactive", egressPolicyRef: "egress_direct-egress@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 60 }, { pollIntervalMs: 1 });
    expect(handle.endpoint).toBe("wss://endpoint");
    await handle.heartbeat();
    await handle.release();
    expect(handle.closed).toBe(true);
    expect(calls.filter((entry) => entry.includes("browser-sessions")).map((entry) => entry.split(" ")[0])).toEqual(["POST", "GET", "POST", "POST"]);
  });

  test("waitForJob returns manual/input handoff states but keeps polling while queued", async () => {
    let reads = 0;
    const { client } = clientWith((request) => {
      if (request.method === "POST") return jsonResponse({ id: "job_1", status: "queued", expiresAt: "2099-01-01T00:00:00Z" }, 201);
      reads += 1;
      return jsonResponse({ id: "job_1", status: reads < 2 ? "queued" : "awaiting_manual", expiresAt: "2099-01-01T00:00:00Z" });
    });
    const job = await client.jobs.create({
      project: "project_test" as never,
      idempotencyKey: "job-1",
      recipeRef: "recipe_account-signup@1" as never,
      operation: workloadOperations.signup("signup-config-ref"),
      egressPolicyRef: "egress_esim-direct-assets@1" as never,
      artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
      leaseMode: "interactive",
      ttlSeconds: 60,
    });
    const state = await client.waitForJob(job.id, { pollIntervalMs: 1, maxPollIntervalMs: 2 });
    expect(state.status).toBe("awaiting_manual");
    expect(reads).toBe(2);
  });

  test("maps server problems and transport failures to stable FabricError codes", async () => {
    const { client } = clientWith(() => jsonResponse({ code: "capacity_exhausted", detail: "at capacity", status: 429 }, 429));
    await expect(client.browserSessions.get("browser-session_1")).rejects.toEqual(new FabricError("capacity_exhausted", "at capacity", 429));
    const broken = new BrowserFabricClient({ baseUrl: "https://fabric.example", fetch: async () => { throw new Error("socket details"); } });
    await expect(broken.browserSessions.get("browser-session_1")).rejects.toEqual(new FabricError("internal_error", "Fabric transport request failed", 502));
  });

  test("encryptInputForWorker produces a one-shot envelope decryptable only by the request worker", () => {
    const keys = generateWorkerInputKeyPair(2048);
    const request = { id: "input-request_client" as never, workerId: "worker_client" as never, expiresAt: "2099-01-01T00:00:00.000Z", workerInputEncryptionPublicKeyPem: keys.publicKeyPem };
    const envelope = encryptInputForWorker({ request, value: "client-secret" });
    expect(JSON.stringify(envelope)).not.toContain("client-secret");
    expect(decryptEphemeralInput(envelope as never, keys.privateKeyPem, { requestId: request.id, workerId: request.workerId })).toBe("client-secret");
  });

  test("uploads a project-scoped immutable media manifest before the consuming media job exists", async () => {
    const { client, requests } = clientWith(async () => jsonResponse({
      id: "artifact_media_manifest",
      project: "project_archive",
      kind: "media_manifest",
      sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mimeType: "application/vnd.browser-fabric.media-manifest+json",
      sizeBytes: 108,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-31T00:00:00.000Z",
    }, 201));
    const artifact = await client.artifacts.uploadMediaManifest("project_archive", {
      version: 1,
      mode: "relay",
      provider: "Media",
      url: "https://media.example/video.mp4",
      artifactKind: "video",
      expectedContentTypes: ["video/mp4"],
    }, { label: "media-video" });
    expect(String(artifact.id)).toBe("artifact_media_manifest");
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://fabric.example/v1/projects/project_archive/media-manifests");
    expect(request.headers.get("content-type")).toBe("application/vnd.browser-fabric.media-manifest+json");
    expect(request.headers.get("x-fabric-artifact-kind")).toBe("media_manifest");
    expect(request.headers.get("x-fabric-artifact-label")).toBe("media-video");
    expect(await request.json()).toEqual({
      version: 1,
      mode: "relay",
      provider: "Media",
      url: "https://media.example/video.mp4",
      artifactKind: "video",
      expectedContentTypes: ["video/mp4"],
    });
  });
});

describe("workload adapter boundaries", () => {
  test("builds exact reviewed defaults and keeps workload metadata scalar", () => {
    const session = buildWorkloadSession({ workload: "chat", project: "project_chat" as never, idempotencyKey: "chat-1", profileRef: "profile_chat" as never });
    expect(session).toMatchObject({ runtime: "chromium-cdp", browserRecipeRef: "recipe_chat-browser-controller@1", leaseMode: "interactive", egressPolicyRef: "egress_tor-egress@1" });
    const job = buildWorkloadJob({ workload: "insights", project: "project_insights" as never, idempotencyKey: "tik-1", profileRef: "profile_social" as never, operation: workloadOperations.socialInsights("creator") });
    expect(job).toMatchObject({ recipeRef: "recipe_social-insights@1", egressPolicyRef: "egress_social-proxy-fallback@1" });
    expect(job.metadata).toEqual({ workload: "insights" });
    const playback = buildWorkloadJob({
      workload: "media",
      project: "project_media" as never,
      idempotencyKey: "media-playback-1",
      recipeRef: "recipe_media-playback@1" as never,
      operation: workloadOperations.mediaPlayback("artifact_playback_manifest"),
    });
    expect(playback).toMatchObject({
      recipeRef: "recipe_media-playback@1",
      leaseMode: "clone",
      egressPolicyRef: "egress_media-proxy-affinity@1",
      metadata: { workload: "media" },
    });
    expect(playback.profileRef).toBeUndefined();
  });

  test("rejects durable credentials instead of silently forwarding them", () => {
    expect(() => buildWorkloadJob({ workload: "insights", project: "project_insights" as never, idempotencyKey: "tik-2", profileRef: "profile_social" as never, operation: { operation: "collect_insights", username: "creator", cookie: "secret" } })).toThrow(FabricError);
    expect(() => buildWorkloadSession({ workload: "reporting-support", project: "project_reporting" as never, idempotencyKey: "p-1" })).toThrow(/profileRef/);
    expect(() => buildWorkloadJob({
      workload: "media",
      project: "project_media" as never,
      idempotencyKey: "media-playback-profile",
      recipeRef: "recipe_media-playback@1" as never,
      profileRef: "profile_media" as never,
      operation: workloadOperations.mediaPlayback("artifact_playback_manifest"),
    })).toThrow(/must not attach a browser profile/);
  });
});
