import { FabricError, type Worker } from "@browser-fabric/contracts";
import { AssignmentSigner, bunMtlsServerTls, createBunMtlsFetch, createPostgresScheduler, HttpEncryptedInputBroker, mtlsFilesFromEnv, type BrowserScheduler, type EncryptedInputBroker, type PostgresSchedulerRuntime } from "@browser-fabric/control-plane";
import { parseWorkerRegistration, workerPrincipal } from "./protocol";
import { ManagedWorkerController } from "./controller";
import { DockerMediaServiceExecutor, DockerServiceExecutor } from "./docker-executor";

export interface WorkerManagerFetchOptions { scheduler: BrowserScheduler; assignmentSigner: AssignmentSigner; encryptedInputBroker?: EncryptedInputBroker; }

function response(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } }); }
function errorResponse(error: unknown): Response { const body = error instanceof FabricError ? error.toProblem() : new FabricError("internal_error", "worker-manager failure", 500).toProblem(); return response(body, error instanceof FabricError ? error.status : 500); }
async function body(request: Request): Promise<unknown> { try { return await request.json(); } catch { throw new FabricError("validation_failed", "body must be valid JSON", 400); } }
function fingerprint(request: Request): string {
  if (request.headers.get("x-fabric-mtls-verified") !== "true") throw new FabricError("authentication_required", "worker mTLS verification is required", 401);
  const value = request.headers.get("x-fabric-worker-cert-fingerprint");
  if (!value || value.length > 512) throw new FabricError("authentication_required", "worker mTLS fingerprint is required", 401);
  return value;
}

export function createWorkerManagerFetch(options: WorkerManagerFetchOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && url.pathname === "/healthz") return response({ status: "ok" });
      if (request.method === "POST" && url.pathname === "/v1/workers/register") {
        const workerFingerprint = fingerprint(request);
        const worker = parseWorkerRegistration(await body(request), workerFingerprint);
        const enrollment = request.headers.get("x-fabric-worker-enrollment");
        if (!enrollment) throw new FabricError("authentication_required", "worker enrollment token is required", 401);
        return response(await options.scheduler.refreshWorkerRegistration(worker, workerFingerprint, enrollment), 200);
      }
      if (parts[0] !== "v1" || parts[1] !== "workers" || !parts[2]) throw new FabricError("not_found", "worker-manager route not found", 404);
      const workerId = decodeURIComponent(parts[2]) as Worker["id"];
      const snapshot = await options.scheduler.store.snapshot();
      const worker = snapshot.workers.get(workerId);
      if (!worker) throw new FabricError("not_found", "worker not found", 404);
      if (worker.certificateFingerprint !== fingerprint(request)) throw new FabricError("authorization_denied", "worker certificate mismatch", 403);
      const actor = workerPrincipal(worker);
      if (parts[3] === "heartbeat" && request.method === "POST") return response(await options.scheduler.heartbeatWorker(workerId, actor));
      if (parts[3] === "assignments" && request.method === "GET") {
        // Central scheduler may already have allocated work; pull the worker mailbox first.
        const assignments = await options.scheduler.assignmentsForWorker(workerId, 8, actor);
        return response(assignments.map((assignment) => options.assignmentSigner.issue(workerId, assignment)));
      }
      if (parts[3] === "active-assignments" && request.method === "GET") {
        const assignments = await options.scheduler.activeAssignmentsForWorker(workerId, 128, actor);
        return response(assignments.map((assignment) => options.assignmentSigner.issue(workerId, assignment)));
      }
      if (parts[3] === "claim" && request.method === "POST") {
        const input = await body(request) as { leaseId?: string; jobId?: string };
        const claimed = await options.scheduler.claimAssignment(workerId, input.leaseId as never, input.jobId as never, actor);
        return response(options.assignmentSigner.issue(workerId, claimed));
      }
      if (parts[3] === "input-requests" && parts[4] && request.method === "GET") {
        const requestId = decodeURIComponent(parts[4]);
        const envelope = options.encryptedInputBroker
          ? await options.encryptedInputBroker.take(requestId, workerId)
          : await options.scheduler.takeEncryptedEphemeralInput(requestId as never, workerId, actor);
        if (options.encryptedInputBroker) {
          try {
            await options.scheduler.markEncryptedInputConsumed(requestId as never, workerId, actor);
          } catch (error) {
            await Promise.resolve(options.encryptedInputBroker.put(requestId, envelope)).catch(() => undefined);
            throw error;
          }
        }
        return response(envelope);
      }
      if (parts[3] === "leases" && parts[4] && parts[5] === "heartbeat" && request.method === "POST") {
        return response(await options.scheduler.heartbeatLease(decodeURIComponent(parts[4]) as never, workerId, actor));
      }
      if (parts[3] === "jobs" && parts[4] && parts[5] === "complete" && request.method === "POST") {
        const input = await body(request);
        if (input === null || typeof input !== "object" || Array.isArray(input)) throw new FabricError("validation_failed", "job result must be an object", 400);
        return response(await options.scheduler.completeJob(decodeURIComponent(parts[4]) as never, input as Record<string, unknown>, actor));
      }
      if (parts[3] === "jobs" && parts[4] && parts[5] === "fail" && request.method === "POST") {
        const input = await body(request) as Record<string, unknown>;
        const statuses = ["failed", "blocked_challenge", "awaiting_manual", "auth_required"];
        if (!statuses.includes(String(input.status))) throw new FabricError("validation_failed", "job failure status is invalid", 400);
        return response(await options.scheduler.failJob(decodeURIComponent(parts[4]) as never, input.status as never, String(input.reason ?? "worker reported failure"), actor));
      }
      if (parts[3] === "jobs" && parts[4] && parts[5] === "input-requests" && request.method === "POST") {
        const input = await body(request) as Record<string, unknown>;
        const field = String(input.field ?? "");
        const allowedTypes = ["password", "otp", "captcha_provider_credential", "proxy_credential", "form_value"];
        if (!field || !allowedTypes.includes(String(input.fieldType))) throw new FabricError("validation_failed", "input field and fieldType are required", 400);
        const snapshot = await options.scheduler.store.snapshot();
        const job = snapshot.jobs.get(decodeURIComponent(parts[4]) as never);
        if (!job?.leaseId) throw new FabricError("invalid_state", "job has no active lease", 409);
        return response(await options.scheduler.requestEphemeralInput({ jobId: job.id, leaseId: job.leaseId, field, fieldType: String(input.fieldType) as never }, actor), 201);
      }
      throw new FabricError("not_found", "worker-manager route not found", 404);
    } catch (error) { return errorResponse(error); }
  };
}

async function loadSecret(name: string): Promise<string> { const file = process.env[`${name}_FILE`]; if (file) return (await Bun.file(file).text()).trim(); const value = process.env[name]; if (!value) throw new Error(`${name} or ${name}_FILE is required`); return value; }

function optionalBrokerFetch(): ((request: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | undefined {
  const certificateFile = process.env.FABRIC_INPUT_BROKER_CLIENT_CERT_FILE;
  const keyFile = process.env.FABRIC_INPUT_BROKER_CLIENT_KEY_FILE;
  const caFile = process.env.FABRIC_INPUT_BROKER_CLIENT_CA_FILE;
  if (!certificateFile && !keyFile && !caFile) return undefined;
  if (!certificateFile || !keyFile || !caFile) throw new Error("input broker client mTLS requires certificate, key, and CA files");
  return createBunMtlsFetch({ certificateFile, keyFile, caFile });
}

export async function createProductionWorkerManager(): Promise<PostgresSchedulerRuntime> {
  return createPostgresScheduler({ databaseUrl: await loadSecret("FABRIC_DB_URL"), capabilitySecret: await loadSecret("FABRIC_CAPABILITY_SECRET"), gatewayBaseUrl: process.env.FABRIC_GATEWAY_BASE_URL, poolSize: Number(process.env.FABRIC_DB_POOL_SIZE ?? 10), ssl: process.env.FABRIC_DB_SSL === "1" });
}

if (import.meta.main) {
  const runtime = await createProductionWorkerManager();
  const assignmentSigner = new AssignmentSigner(await loadSecret("FABRIC_ASSIGNMENT_PRIVATE_KEY"));
  const network = (name: string, fallback: string) => process.env[`FABRIC_SWARM_NETWORK_${name}`] ?? fallback;
  const browserNetworks = [network("CONTROL", "fabric-control"), network("WORKERS", "fabric-workers")];
  const egressNetwork = network("EGRESS", "fabric-egress");
  const browserExecutor = new DockerServiceExecutor({ workerNodeLabelKey: process.env.FABRIC_WORKER_NODE_LABEL_KEY ?? "fabric-worker-id", browserNetworks, egressNetwork });
  const mediaExecutor = new DockerMediaServiceExecutor({ workerNodeLabelKey: process.env.FABRIC_WORKER_NODE_LABEL_KEY ?? "fabric-worker-id", browserNetworks, egressNetwork });
  const controller = new ManagedWorkerController({ scheduler: runtime.scheduler, browserExecutor, mediaExecutor });
  const brokerUrl = process.env.FABRIC_INPUT_BROKER_URL;
  const encryptedInputBroker = brokerUrl ? new HttpEncryptedInputBroker({ baseUrl: brokerUrl, serviceName: "fabric-worker-manager", fetch: optionalBrokerFetch(), headers: { "x-fabric-mtls-verified": "true" } }) : undefined;
  if (process.env.FABRIC_MANAGED_CONTROLLER !== "0") controller.start();
  const port = Number(process.env.PORT ?? 8082);
  const tlsFiles = mtlsFilesFromEnv("FABRIC_WORKER_MANAGER");
  if (process.env.NODE_ENV === "production" && !tlsFiles) throw new Error("worker-manager requires service mTLS in production");
  Bun.serve({ port, ...(tlsFiles ? { tls: bunMtlsServerTls(tlsFiles) } : {}), fetch: createWorkerManagerFetch({ scheduler: runtime.scheduler, assignmentSigner, ...(encryptedInputBroker ? { encryptedInputBroker } : {}) }) });
  console.info(`Browser Fabric worker-manager listening on :${port}`);
  const shutdown = () => void controller.stop().finally(() => runtime.close().finally(() => process.exit(0)));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
