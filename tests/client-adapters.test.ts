import { describe, expect, test } from "bun:test";
import { BrowserFabricClient, encryptInputForWorker, type FabricClientOptions } from "@browser-fabric/client";
import { buildJobRequest, buildSessionRequest, createFabricClientFromEnvironment } from "@browser-fabric/client";
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
      runtime: "chrome",
      browserRecipeRef: "recipe_chrome@1" as never,
      leaseMode: "interactive",
      egressPolicyRef: "egress_direct@1" as never,
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
      runtime: "chrome",
      browserRecipeRef: "recipe_chrome@1" as never,
      leaseMode: "interactive",
      egressPolicyRef: "egress_direct@1" as never,
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
    const handle = await client.acquireBrowserSession({ project: "project_test" as never, idempotencyKey: "handle-1", runtime: "chrome", browserRecipeRef: "recipe_chrome@1" as never, leaseMode: "interactive", egressPolicyRef: "egress_direct@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 60 }, { pollIntervalMs: 1 });
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
      recipeRef: "recipe_example-fetch@1" as never,
      operation: { operation: "fetch_page", url: "https://site.example" },
      egressPolicyRef: "egress_example-static-direct@1" as never,
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

  test("uploads a session artifact with its kind and label and never sends a storage key", async () => {
    const { client, requests } = clientWith(async () => jsonResponse({
      id: "artifact_shot",
      project: "project_example",
      sessionId: "browser-session_1",
      kind: "screenshot",
      sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mimeType: "image/png",
      sizeBytes: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-31T00:00:00.000Z",
    }, 201));
    const artifact = await client.artifacts.uploadForSession("browser-session_1", { kind: "screenshot", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]), label: "home-page" });
    expect(String(artifact.id)).toBe("artifact_shot");
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://fabric.example/v1/browser-sessions/browser-session_1/artifacts");
    expect(request.headers.get("content-type")).toBe("image/png");
    expect(request.headers.get("x-fabric-artifact-kind")).toBe("screenshot");
    expect(request.headers.get("x-fabric-artifact-label")).toBe("home-page");
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    await expect(client.artifacts.uploadForSession("browser-session_1", { kind: "cookie_jar" as never, contentType: "application/json", bytes: new Uint8Array([1]) })).rejects.toThrow();
  });
});

describe("request builders", () => {
  test("builds a session request from explicit refs with the default artifact policy and lease TTLs", () => {
    const session = buildSessionRequest({ project: "project_example" as never, idempotencyKey: "interactive-1", runtime: "chrome", recipeRef: "recipe_chrome@1" as never, egressPolicyRef: "egress_tor@1" as never, profileRef: "profile_example_interactive" as never, leaseMode: "interactive", metadata: { ticket: "T-1" } });
    expect(session).toEqual({
      project: "project_example",
      idempotencyKey: "interactive-1",
      runtime: "chrome",
      browserRecipeRef: "recipe_chrome@1",
      profileRef: "profile_example_interactive",
      leaseMode: "interactive",
      egressPolicyRef: "egress_tor@1",
      artifactPolicyRef: "artifact-policy_standard-30-days@1",
      metadata: { ticket: "T-1" },
      ttlSeconds: 1_800,
    } as never);
    const headless = buildSessionRequest({ project: "project_example" as never, idempotencyKey: "headless-1", runtime: "chrome", recipeRef: "recipe_chrome-headless@1" as never, egressPolicyRef: "egress_direct@1" as never, maxExternalConnections: 3 });
    expect(headless).toMatchObject({ leaseMode: "writer", ttlSeconds: 900, maxExternalConnections: 3 });
    expect(headless.profileRef).toBeUndefined();
    expect(headless.metadata).toBeUndefined();
  });

  test("builds a typed job request from explicit refs and copies the operation", () => {
    const operation = { operation: "fetch_page", url: "https://site.example", cookieJarRef: "artifact_jar" };
    const job = buildJobRequest({ project: "project_example" as never, idempotencyKey: "fetch-1", recipeRef: "recipe_example-fetch@1" as never, operation, egressPolicyRef: "egress_direct@1" as never, profileRef: "profile_default" as never, callback: { url: "https://app.example/hook" } });
    expect(job).toEqual({
      project: "project_example",
      idempotencyKey: "fetch-1",
      recipeRef: "recipe_example-fetch@1",
      operation: { operation: "fetch_page", url: "https://site.example", cookieJarRef: "artifact_jar" },
      profileRef: "profile_default",
      egressPolicyRef: "egress_direct@1",
      artifactPolicyRef: "artifact-policy_standard-30-days@1",
      callback: { url: "https://app.example/hook" },
    } as never);
    expect(job.operation).not.toBe(operation);
    expect(job.leaseMode).toBeUndefined();
  });

  test("rejects durable credentials, bad idempotency keys and non-scalar-safe metadata", () => {
    const base = { project: "project_example" as never, recipeRef: "recipe_example-fetch@1" as never, egressPolicyRef: "egress_direct@1" as never };
    expect(() => buildJobRequest({ ...base, idempotencyKey: "j-1", operation: { operation: "fetch_page", url: "https://site.example", cookie: "secret" } })).toThrow(FabricError);
    expect(() => buildJobRequest({ ...base, idempotencyKey: "j-1", operation: { operation: "fetch_page", nested: [{ apiKey: "secret" }] } })).toThrow(/operation.nested\[0\].apiKey/);
    expect(buildJobRequest({ ...base, idempotencyKey: "j-1", operation: { operation: "fetch_page", cookieJarRef: "artifact_jar" } }).operation).toEqual({ operation: "fetch_page", cookieJarRef: "artifact_jar" });
    expect(() => buildJobRequest({ ...base, idempotencyKey: "", operation: { operation: "fetch_page" } })).toThrow(/idempotencyKey/);
    expect(() => buildJobRequest({ ...base, idempotencyKey: "x".repeat(256), operation: { operation: "fetch_page" } })).toThrow(/idempotencyKey/);
    expect(() => buildSessionRequest({ ...base, idempotencyKey: "s-1", runtime: "chrome", metadata: { "bad key": "x" } })).toThrow(/metadata key/);
    expect(() => buildSessionRequest({ ...base, idempotencyKey: "s-1", runtime: "chrome", metadata: { note: "x".repeat(513) } })).toThrow(/too long/);
  });

  test("an environment client requires an opaque principal ID and a strong password", () => {
    const previous = { url: process.env.FABRIC_API_URL, username: process.env.FABRIC_API_USERNAME, password: process.env.FABRIC_API_PASSWORD };
    try {
      process.env.FABRIC_API_URL = "https://fabric.example/v1";
      process.env.FABRIC_API_USERNAME = "admin";
      process.env.FABRIC_API_PASSWORD = "p".repeat(32);
      expect(() => createFabricClientFromEnvironment()).toThrow(/principal ID/);
      process.env.FABRIC_API_USERNAME = "principal_admin";
      process.env.FABRIC_API_PASSWORD = "short";
      expect(() => createFabricClientFromEnvironment()).toThrow(/24 to 4096/);
      process.env.FABRIC_API_PASSWORD = "p".repeat(32);
      expect(createFabricClientFromEnvironment()).toBeInstanceOf(BrowserFabricClient);
    } finally {
      for (const [key, value] of [["FABRIC_API_URL", previous.url], ["FABRIC_API_USERNAME", previous.username], ["FABRIC_API_PASSWORD", previous.password]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});
