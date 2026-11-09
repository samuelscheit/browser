import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { RemoteBackend, fetchIdentity } from "../apps/cli/src/remote-backend";
import { agentIdentity, remoteRequest } from "./support/fabric-identity";

const PASSWORD = "correct horse battery staple";
const AUTH = `Basic ${Buffer.from(`principal_agent:${PASSWORD}`).toString("base64")}`;

/** A scripted Fabric API: sessions move through `statuses` on each GET. */
class FakeFabric {
  readonly created: { body: Record<string, any>; idempotencyKey: string | null }[] = [];
  readonly calls: string[] = [];
  readonly sessions = new Map<string, { statuses: string[]; status: string }>();
  statuses: string[] = ["allocating", "ready"];
  server?: Server<undefined>;

  get url() { return `http://127.0.0.1:${this.server!.port}/v1`; }

  start(): this {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        this.calls.push(`${request.method} ${path}`);
        if (request.headers.get("authorization") !== AUTH) return new Response(null, { status: 401 });
        if (path === "/v1/me") return Response.json(agentIdentity());
        if (path === "/v1/browser-sessions" && request.method === "POST") {
          const body = await request.json() as Record<string, any>;
          this.created.push({ body, idempotencyKey: request.headers.get("idempotency-key") });
          const id = `browser-session_${this.created.length}`;
          this.sessions.set(id, { statuses: [...this.statuses], status: "queued" });
          return Response.json({ id, status: "queued", expiresAt: "2099-01-01T00:00:00Z" }, { status: 201 });
        }
        const match = /^\/v1\/browser-sessions\/([^/]+)(?:\/(release|cancel|events))?$/.exec(path);
        const session = match ? this.sessions.get(match[1]!) : undefined;
        if (!match || !session) return Response.json({ detail: "not found" }, { status: 404 });
        if (match[2] === "release") session.status = "released";
        else if (match[2] === "cancel") session.status = "cancelled";
        else if (match[2] === "events") return Response.json([{ type: "browser_session.failed", payload: { reason: "no capacity" } }]);
        else if (session.statuses.length) session.status = session.statuses.shift()!;
        const ready = session.status === "ready" || session.status === "active";
        return Response.json({
          id: match[1], status: session.status, expiresAt: "2099-01-01T00:00:00Z",
          ...(ready ? { cdpEndpoint: `wss://fabric.test/v1/cdp/${match[1]}?cap=cap-${this.calls.length}` } : {}),
        });
      },
    });
    return this;
  }
}

const servers: FakeFabric[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.server?.stop(true); });

function setup(options: { password?: string; statuses?: string[]; fresh?: boolean; queueTimeoutMs?: number } = {}) {
  const fabric = new FakeFabric();
  if (options.statuses) fabric.statuses = options.statuses;
  fabric.start();
  servers.push(fabric);
  const sessions: (string | undefined)[] = [];
  const logs: string[] = [];
  const backend = new RemoteBackend({
    credentials: { url: fabric.url, username: "principal_agent", password: options.password ?? PASSWORD },
    request: remoteRequest({ fresh: options.fresh ?? false }),
    queueTimeoutMs: options.queueTimeoutMs ?? 5_000,
    log: (message) => logs.push(message),
    onSession: (sessionId) => sessions.push(sessionId),
  });
  return { fabric, backend, sessions, logs };
}

describe("remote backend", () => {
  test("creates one session with agent defaults and returns an authenticated, fresh endpoint per client", async () => {
    const { fabric, backend, sessions } = setup();
    const first = await backend.acquire();
    expect(first).toEqual({ url: expect.stringMatching(/^wss:\/\/fabric\.test\/v1\/cdp\/browser-session_1\?cap=/), headers: { authorization: AUTH } });
    expect(fabric.created).toHaveLength(1);
    const { body, idempotencyKey } = fabric.created[0]!;
    expect(idempotencyKey).toBe(body.idempotencyKey);
    expect(body).toMatchObject({ project: "project_agent", profileRef: "profile_agent", browserRecipeRef: "recipe_interactive-chromium@1", leaseMode: "interactive", maxExternalConnections: 8, ttlSeconds: 14_400 });
    const second = await backend.acquire();
    expect(fabric.created).toHaveLength(1);
    // Each client reads the session again, so it gets the current short-lived capability.
    expect(second.url).not.toBe(first.url);
    expect(sessions).toEqual(["browser-session_1"]);
    expect(backend.describe()).toMatchObject({ sessionId: "browser-session_1", profile: "profile_agent" });
  });

  test("concurrent clients during startup share one session", async () => {
    const { fabric, backend } = setup();
    await Promise.all([backend.acquire(), backend.acquire(), backend.acquire()]);
    expect(fabric.created).toHaveLength(1);
  });

  test("replaces a session that ended (TTL, reconnect grace) on the next client", async () => {
    const { fabric, backend, sessions } = setup();
    await backend.acquire();
    fabric.sessions.get("browser-session_1")!.status = "timed_out";
    fabric.sessions.get("browser-session_1")!.statuses = [];
    const endpoint = await backend.acquire();
    expect(endpoint.url).toContain("browser-session_2");
    expect(sessions).toEqual(["browser-session_1", undefined, "browser-session_2"]);
  });

  test("suspend releases the session; the next client starts a new one", async () => {
    const { fabric, backend, sessions } = setup();
    await backend.acquire();
    await backend.suspend();
    expect(fabric.calls).toContain("POST /v1/browser-sessions/browser-session_1/release");
    expect(backend.describe().sessionId).toBeUndefined();
    await backend.suspend();
    expect(fabric.calls.filter((call) => call.endsWith("/release"))).toHaveLength(1);
    expect((await backend.acquire()).url).toContain("browser-session_2");
    expect(sessions).toEqual(["browser-session_1", undefined, "browser-session_2"]);
  });

  test("--fresh sessions carry no profile", async () => {
    const { fabric, backend } = setup({ fresh: true });
    await backend.acquire();
    expect(fabric.created[0]!.body.profileRef).toBeUndefined();
    expect(backend.describe().detail).toContain("fresh profile");
  });

  test("a session stuck in the queue is cancelled with an explanation instead of hanging", async () => {
    const { fabric, backend } = setup({ statuses: Array(1000).fill("queued"), queueTimeoutMs: 600 });
    const error = await backend.acquire().catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("No remote browser became ready within 1 s");
    expect((error as Error).message).toContain("profile_agent is used by one session at a time");
    expect((error as Error).message).toContain("fabric up --remote --fresh");
    expect(fabric.calls).toContain("POST /v1/browser-sessions/browser-session_1/cancel");
  });

  test("a session that fails reports Fabric's last event", async () => {
    const { backend } = setup({ statuses: ["failed"] });
    await expect(backend.acquire()).rejects.toThrow(/browser-session_1 ended as failed: .*no capacity/);
  });

  test("a wrong credential explains the principal ID format", async () => {
    const { fabric } = setup();
    await expect(fetchIdentity({ url: fabric.url, username: "principal_agent", password: "wrong" })).rejects.toThrow(/look like principal_agent/);
    expect((await fetchIdentity({ url: fabric.url, username: "principal_agent", password: PASSWORD })).principal).toBe("principal_agent" as never);
  });
});
