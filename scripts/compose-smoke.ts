/**
 * End-to-end smoke test of a running deploy/compose stack through its edge:
 *
 *   bun scripts/compose-smoke.ts [--url http://127.0.0.1:18086/v1] [--principal admin] [--page https://example.com/]
 *
 * Reads the principal's password from deploy/compose/secrets/principals/<name>, discovers its
 * project and profile with GET /v1/me, leases a raw-CDP browser (recipe_chrome@1 by default, egress
 * direct), drives it over the gateway WebSocket (version, navigation through the egress sidecar,
 * a JavaScript evaluation, the masked WebGL renderer) and releases the session. Exits non-zero on
 * the first failed step.
 */
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import WebSocket from "ws";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:18086/v1" },
    principal: { type: "string", default: "admin" },
    page: { type: "string", default: "https://example.com/" },
    recipe: { type: "string", default: "recipe_chrome@1" },
    egress: { type: "string", default: "egress_direct@1" },
  },
});

const base = values.url!.replace(/\/$/, "");
const username = `principal_${values.principal}`;
const password = (await readFile(new URL(`../deploy/compose/secrets/principals/${values.principal}`, import.meta.url), "utf8")).trim();
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

function step(message: string): void { console.log(`✓ ${message}`); }

async function api<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

const unauthenticated = await fetch(`${base}/me`);
if (unauthenticated.status !== 401) throw new Error(`the edge must refuse a request without credentials (got HTTP ${unauthenticated.status})`);
step("edge refuses a request without credentials");

const me = await api<{ principal: string; projects: { id: string }[]; profiles: { ref: string; profileFamily: string }[]; recipes: { ref: string; runtime: string }[]; egressPolicies: string[] }>("GET", "/me");
const project = me.projects[0]?.id;
const recipe = me.recipes.find((candidate) => candidate.ref === values.recipe);
if (!project || !recipe) throw new Error(`principal ${me.principal} has no project or the recipe ${values.recipe} is not served`);
if (!me.egressPolicies.includes(values.egress!)) throw new Error(`egress policy ${values.egress} is not available`);
step(`GET /v1/me as ${me.principal}: project ${project}, ${me.recipes.length} served recipes, egress ${me.egressPolicies.join(", ")}`);

const idempotencyKey = `compose-smoke-${crypto.randomUUID()}`;
const created = await api<{ id: string; status: string }>("POST", "/browser-sessions", {
  project,
  idempotencyKey,
  runtime: recipe.runtime,
  browserRecipeRef: recipe.ref,
  leaseMode: "writer",
  egressPolicyRef: values.egress,
  artifactPolicyRef: "artifact-policy_standard-30-days@1",
  ttlSeconds: 300,
}, { "idempotency-key": idempotencyKey });
step(`created browser session ${created.id} (${created.status})`);

let session: { id: string; status: string; cdpEndpoint?: string; failureReason?: string } = created;
const deadline = Date.now() + 120_000;
while (session.status !== "ready" && session.status !== "active") {
  if (["failed", "cancelled", "timed_out", "released"].includes(session.status)) throw new Error(`session ended as ${session.status}: ${session.failureReason ?? "no reason"}`);
  if (Date.now() > deadline) throw new Error(`session stayed ${session.status} for 120 s`);
  await Bun.sleep(1_000);
  session = await api("GET", `/browser-sessions/${encodeURIComponent(created.id)}`);
}
if (!session.cdpEndpoint) throw new Error("ready session has no CDP endpoint");
step(`session ready on ${new URL(session.cdpEndpoint).origin}`);

try {
  const socket = new WebSocket(session.cdpEndpoint, { headers: { authorization } });
  await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  socket.on("message", (data) => {
    const message = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error.message));
    else waiter?.resolve(message.result);
  });
  const send = <T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)); }, 60_000);
  });

  const version = await send<{ product: string }>("Browser.getVersion");
  step(`CDP Browser.getVersion: ${version.product}`);
  const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Page.navigate", { url: values.page }, sessionId);
  let title = "";
  for (let attempt = 0; attempt < 60 && !title; attempt += 1) {
    await Bun.sleep(500);
    const evaluated = await send<{ result: { value?: string } }>("Runtime.evaluate", { expression: "document.readyState === 'complete' ? document.title : ''", returnByValue: true }, sessionId);
    title = evaluated.result.value ?? "";
  }
  if (!title) throw new Error(`${values.page} did not finish loading through the egress sidecar`);
  step(`navigated to ${values.page} through the egress sidecar: "${title}"`);
  const renderer = await send<{ result: { value?: string } }>("Runtime.evaluate", {
    expression: "(() => { const gl = document.createElement('canvas').getContext('webgl'); const info = gl && gl.getExtension('WEBGL_debug_renderer_info'); return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'no-webgl'; })()",
    returnByValue: true,
  }, sessionId);
  // A browser without WebGL is an obvious automation signal; both recipes must expose it.
  if (!renderer.result.value || renderer.result.value === "no-webgl") throw new Error("pages see no WebGL");
  step(`WebGL renderer reported to pages: ${renderer.result.value}`);
  socket.close();
} finally {
  await api("POST", `/browser-sessions/${encodeURIComponent(created.id)}/release`).catch((error: unknown) => console.error(`release failed: ${(error as Error).message}`));
}
const released = await api<{ status: string }>("GET", `/browser-sessions/${encodeURIComponent(created.id)}`);
step(`session released (${released.status})`);
