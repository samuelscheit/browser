import {
  FabricError,
  parseInputFieldType,
  parseInputValue,
  parseBrowserSessionCreate,
  parseProfileCreate,
  parseJobCreate,
  type Principal
} from "@browser-fabric/contracts";
import { BrowserScheduler } from "@browser-fabric/control-plane";
import { parseWorkerRegistration } from "../../worker-manager/src/protocol";
import type { EncryptedInputBroker } from "@browser-fabric/control-plane";

export interface ApiServerOptions {
  scheduler: BrowserScheduler;
  encryptedInputBroker?: EncryptedInputBroker;
  /** Production deployment should derive this only after Traefik mTLS verification. */
  authenticate(request: Request): Promise<Principal | undefined> | Principal | undefined;
  corsOrigins?: readonly string[];
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

function problem(error: unknown): Response {
  if (error instanceof FabricError) return new Response(JSON.stringify(error.toProblem()), { status: error.status, headers: { "content-type": "application/problem+json; charset=utf-8" } });
  // Never log an arbitrary exception: worker/recipe adapters may accidentally include an
  // ephemeral input in their message. Production telemetry records only this stable code.
  console.error("unhandled Fabric API error (details intentionally omitted)");
  return new Response(JSON.stringify(new FabricError("internal_error", "internal server error", 500).toProblem()), { status: 500, headers: { "content-type": "application/problem+json; charset=utf-8" } });
}

async function requestJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new FabricError("validation_failed", "request content type must be application/json", 415);
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > 1_048_576)) throw new FabricError("validation_failed", "JSON request body is larger than the 1 MiB control-plane limit", 413);
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 1_048_576) throw new FabricError("validation_failed", "JSON request body is larger than the 1 MiB control-plane limit", 413);
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof FabricError) throw error;
    throw new FabricError("validation_failed", "request body must be valid JSON", 400);
  }
}

function requireIdempotencyHeader(request: Request, body: { idempotencyKey?: string }): void {
  const header = request.headers.get("idempotency-key");
  if (!header) throw new FabricError("validation_failed", "Idempotency-Key header is required", 400);
  if (body.idempotencyKey !== header) throw new FabricError("validation_failed", "Idempotency-Key header must equal body.idempotencyKey", 400);
}

function pathParts(url: URL): string[] {
  const parts = url.pathname.split("/").filter(Boolean);
  // The public ingress mounts the API under /v1; accepting the unprefixed form keeps
  // the handler reusable behind a private service mesh without changing the contract.
  return parts[0] === "v1" ? parts.slice(1) : parts;
}

function sseEncode(event: { id: string; sequence: number; type: string; payload: unknown; createdAt: string }): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({ id: event.id, sequence: event.sequence, payload: event.payload, createdAt: event.createdAt })}\n\n`;
}

async function sseResponse(stream: AsyncIterable<{ id: string; sequence: number; type: string; payload: unknown; createdAt: string }>, signal: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (signal.aborted) break;
          controller.enqueue(encoder.encode(sseEncode(event)));
        }
      } catch (error) {
        controller.error(error);
        return;
      }
      controller.close();
    },
    cancel() { /* iterator observes the request abort signal */ }
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", ...extraHeaders } });
}

export function createApiFetch(options: ApiServerOptions): (request: Request) => Promise<Response> {
  const corsOrigins = new Set(options.corsOrigins ?? []);
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    const corsHeaders: Record<string, string> = origin && corsOrigins.has(origin) ? { "access-control-allow-origin": origin, vary: "origin" } : {};
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...corsHeaders, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,idempotency-key" } });
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") return json({ status: "ok" }, 200, corsHeaders);
      const actor = await options.authenticate(request);
      if (!actor) throw new FabricError("authentication_required", "mutual TLS principal is required", 401);
      const parts = pathParts(url);
      if (request.method === "GET" && (url.pathname === "/openapi.yaml" || url.pathname === "/v1/openapi.yaml")) {
        const file = Bun.file(new URL("../../../packages/contracts/openapi/browser-fabric.openapi.yaml", import.meta.url));
        return new Response(await file.text(), { status: 200, headers: { "content-type": "application/yaml; charset=utf-8", ...corsHeaders } });
      }
      if (parts.length === 1 && parts[0] === "browser-sessions" && request.method === "POST") {
        const parsed = parseBrowserSessionCreate(await requestJson(request));
        requireIdempotencyHeader(request, parsed);
        const response = await options.scheduler.createBrowserSession(parsed, actor);
        return json(response, response.status === "queued" ? 201 : 200, corsHeaders);
      }
      if (parts[0] === "browser-sessions" && parts[1]) {
        const sessionId = decodeURIComponent(parts[1]) as never;
        if (parts.length === 2 && request.method === "GET") return json(await options.scheduler.getSession(sessionId, actor), 200, corsHeaders);
        if (parts[2] === "heartbeat" && request.method === "POST") return json(await options.scheduler.heartbeatSession(sessionId, actor), 200, corsHeaders);
        if (parts[2] === "release" && request.method === "POST") return json(await options.scheduler.releaseBrowserSession(sessionId, actor), 200, corsHeaders);
        if (parts[2] === "cancel" && request.method === "POST") return json(await options.scheduler.cancelBrowserSession(sessionId, actor), 200, corsHeaders);
        if (parts[2] === "events" && request.method === "GET") {
          if (request.headers.get("accept")?.includes("text/event-stream")) {
            const afterSequence = Number(new URL(request.url).searchParams.get("after") ?? request.headers.get("last-event-id") ?? 0);
            return sseResponse(options.scheduler.watchEvents({ kind: "browser_session", id: sessionId }, { afterSequence, signal: request.signal, actor }), request.signal, corsHeaders);
          }
          return json(await options.scheduler.events({ kind: "browser_session", id: sessionId }, actor), 200, corsHeaders);
        }
        if (parts[2] === "input-requests" && request.method === "POST") {
          const input = await requestJson(request) as Record<string, unknown>;
          return json(await options.scheduler.requestEphemeralInput({ sessionId, leaseId: input.leaseId as never, field: String(input.field ?? ""), fieldType: parseInputFieldType(input.fieldType) }, actor), 201, corsHeaders);
        }
      }
      if (parts.length === 1 && parts[0] === "jobs" && request.method === "POST") {
        const parsed = parseJobCreate(await requestJson(request));
        requireIdempotencyHeader(request, parsed);
        const response = await options.scheduler.createJob(parsed, actor);
        return json(response, response.status === "queued" ? 201 : 200, corsHeaders);
      }
      if (parts[0] === "jobs" && parts[1]) {
        const jobId = decodeURIComponent(parts[1]) as never;
        if (parts.length === 2 && request.method === "GET") return json(await options.scheduler.getJob(jobId, actor), 200, corsHeaders);
        if (parts[2] === "cancel" && request.method === "POST") return json(await options.scheduler.cancelJob(jobId, actor), 200, corsHeaders);
        if (parts[2] === "resume" && request.method === "POST") return json(await options.scheduler.resumeJob(jobId, actor), 200, corsHeaders);
        if (parts[2] === "events" && request.method === "GET") {
          if (request.headers.get("accept")?.includes("text/event-stream")) {
            const afterSequence = Number(new URL(request.url).searchParams.get("after") ?? request.headers.get("last-event-id") ?? 0);
            return sseResponse(options.scheduler.watchEvents({ kind: "job", id: jobId }, { afterSequence, signal: request.signal, actor }), request.signal, corsHeaders);
          }
          return json(await options.scheduler.events({ kind: "job", id: jobId }, actor), 200, corsHeaders);
        }
        if (parts[2] === "input-requests" && request.method === "POST") {
          const input = await requestJson(request) as Record<string, unknown>;
          return json(await options.scheduler.requestEphemeralInput({ jobId, leaseId: input.leaseId as never, field: String(input.field ?? ""), fieldType: parseInputFieldType(input.fieldType) }, actor), 201, corsHeaders);
        }
      }
      if (parts[0] === "input-requests" && parts[1] && parts[2] === "value" && request.method === "POST") {
        const input = await requestJson(request) as Record<string, unknown>;
        return json(await options.scheduler.provideEphemeralInput(decodeURIComponent(parts[1]) as never, parseInputValue(input.value), actor), 200, corsHeaders);
      }
      if (parts[0] === "input-requests" && parts[1] && parts[2] === "envelope" && request.method === "POST") {
        const envelope = await requestJson(request) as Record<string, unknown>;
        const requestId = decodeURIComponent(parts[1]);
        if (options.encryptedInputBroker) {
          await options.encryptedInputBroker.put(requestId, envelope as never);
        }
        try {
          const result = await options.scheduler.provideEncryptedEphemeralInput(requestId as never, envelope as never, actor);
          // The external broker is the cross-process source of truth. Remove the duplicate
          // ciphertext from this API replica's local router immediately.
          if (options.encryptedInputBroker) options.scheduler.ephemeralInputVault.discard(requestId as never);
          return json(result, 200, corsHeaders);
        } catch (error) {
          // Keep a broker envelope when the scheduler reports an already-supplied retry; discard
          // only envelopes rejected before acceptance (otherwise a lost client response could
          // delete the worker's only copy).
          if (!(error instanceof FabricError && error.code === "invalid_state")) {
            await Promise.resolve(options.encryptedInputBroker?.discard(requestId)).catch(() => undefined);
          }
          throw error;
        }
      }
      if (parts.length === 1 && parts[0] === "profiles" && request.method === "POST") {
        return json(await options.scheduler.createProfile(parseProfileCreate(await requestJson(request)), actor), 201, corsHeaders);
      }
      if (parts.length === 1 && parts[0] === "profiles" && request.method === "GET") {
        const project = url.searchParams.get("project");
        if (!project) throw new FabricError("validation_failed", "project query parameter is required", 400);
        return json(await options.scheduler.listProfiles(project as never, actor), 200, corsHeaders);
      }
      if (parts[0] === "profiles" && parts[1]) {
        const profileRef = decodeURIComponent(parts[1]) as never;
        if (parts.length === 2 && request.method === "GET") return json(await options.scheduler.getProfile(profileRef, actor), 200, corsHeaders);
        if (parts[2] === "grants" && request.method === "POST") {
          const input = await requestJson(request) as Record<string, unknown>;
          if (typeof input.project !== "string") throw new FabricError("validation_failed", "project is required", 400);
          return json(await options.scheduler.grantProfile(profileRef, input.project as never, actor), 200, corsHeaders);
        }
        if (parts[2] === "revoke" && request.method === "POST") return json(await options.scheduler.revokeProfile(profileRef, actor), 200, corsHeaders);
        if (parts[2] === "relocate" && request.method === "POST") {
          const input = await requestJson(request) as Record<string, unknown>;
          if (typeof input.targetWorkerId !== "string" || typeof input.verifiedChecksum !== "string") throw new FabricError("validation_failed", "targetWorkerId and verifiedChecksum are required", 400);
          return json(await options.scheduler.relocateProfile(profileRef, input.targetWorkerId as never, input.verifiedChecksum, actor), 200, corsHeaders);
        }
      }
      if (parts.length === 1 && parts[0] === "workers" && request.method === "GET") return json(await options.scheduler.listWorkers(actor), 200, corsHeaders);
      if (parts.length === 1 && parts[0] === "workers" && request.method === "POST") {
        const input = await requestJson(request) as Record<string, unknown>;
        if (typeof input.certificateFingerprint !== "string") throw new FabricError("validation_failed", "certificateFingerprint is required", 400);
        return json(await options.scheduler.registerWorker(parseWorkerRegistration(input, input.certificateFingerprint)), 201, corsHeaders);
      }
      if (parts[0] === "workers" && parts[1] && parts.length === 2 && request.method === "GET") return json(await options.scheduler.getWorker(decodeURIComponent(parts[1]) as never, actor), 200, corsHeaders);
      if (parts[0] === "workers" && parts[1] && parts[2] === "health" && request.method === "POST") {
        const input = await requestJson(request) as Record<string, unknown>;
        if (!["healthy", "degraded", "offline", "draining"].includes(String(input.health))) throw new FabricError("validation_failed", "worker health is invalid", 400);
        return json(await options.scheduler.setWorkerHealth(decodeURIComponent(parts[1]) as never, input.health as never, actor), 200, corsHeaders);
      }
      throw new FabricError("not_found", "route not found", 404);
    } catch (error) {
      const response = problem(error);
      for (const [key, value] of Object.entries(corsHeaders)) response.headers.set(key, value);
      return response;
    }
  };
}

function localPrincipal(request: Request): Principal | undefined {
  // Development only. Production Traefik injects an mTLS-verified principal header over a private network.
  if (process.env.FABRIC_DEV_AUTH !== "1") return undefined;
  const project = request.headers.get("x-fabric-project") ?? "project_demo";
  return {
    id: "principal_dev" as Principal["id"],
    displayName: "development principal",
    projectGrants: [project as Principal["projectGrants"][number]],
    roles: ["fabric_admin", "project_admin"],
    certificateFingerprint: "development",
    createdAt: new Date().toISOString()
  };
}

if (import.meta.main) {
  const scheduler = new BrowserScheduler();
  await scheduler.bootstrap({
    projects: [{ id: "project_demo" as never, name: "Demo" }],
    principals: [{ id: "principal_dev" as never, displayName: "development principal", projectGrants: ["project_demo" as never], roles: ["fabric_admin", "project_admin"], certificateFingerprint: "development", createdAt: new Date().toISOString() }]
  });
  const port = Number(process.env.PORT ?? 8080);
  Bun.serve({ port, fetch: createApiFetch({ scheduler, authenticate: localPrincipal }) });
  console.info(`Browser Fabric API listening on :${port}`);
}
