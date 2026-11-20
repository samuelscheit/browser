import { FabricError, type Worker } from "@browser-fabric/contracts";
import { AssignmentSigner, bunMtlsServerTls, createBunMtlsFetch, createPostgresScheduler, HttpEncryptedInputBroker, mtlsFilesFromEnv, type BrowserScheduler, type EncryptedInputBroker, type PostgresSchedulerRuntime } from "@browser-fabric/control-plane";
import { parseWorkerRegistration, workerPrincipal } from "./protocol";
import { ManagedWorkerController } from "./controller";
import { CHROMIUM_SECCOMP_PROFILE_PATH, DockerContainerExecutor } from "./docker-container-executor";
import { captchaSolvingFromEnvironment } from "./captcha-solver-factory";
import { egressSidecarListeners } from "@browser-fabric/policy";

export interface WorkerManagerFetchOptions {
  scheduler: BrowserScheduler;
  assignmentSigner: AssignmentSigner;
  encryptedInputBroker?: EncryptedInputBroker;
}

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
      const enrollment = request.headers.get("x-fabric-worker-enrollment");
      if (!enrollment) throw new FabricError("authentication_required", "worker enrollment token is required", 401);
      // Registration refresh validates the same token itself. Every subsequent action must prove
      // it again: the manager cannot derive a peer certificate fingerprint from Bun's Request.
      const worker = await options.scheduler.authenticateWorkerControlChannel(workerId, fingerprint(request), enrollment);
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
        const input = await body(request) as { leaseId?: unknown };
        if (typeof input.leaseId !== "string") throw new FabricError("validation_failed", "leaseId is required", 400);
        const claimed = await options.scheduler.claimAssignment(workerId, input.leaseId as never, actor);
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
      if (parts[3] === "leases" && parts[4] && parts[5] === "started" && request.method === "POST") {
        return response(await options.scheduler.markLeaseStarted(decodeURIComponent(parts[4]) as never, workerId, actor));
      }
      if (parts[3] === "leases" && parts[4] && parts[5] === "failed" && request.method === "POST") {
        const input = await body(request) as { reason?: unknown };
        const reason = typeof input.reason === "string" ? input.reason : "worker reported an unrecoverable browser failure";
        await options.scheduler.failLease(decodeURIComponent(parts[4]) as never, workerId, reason, actor);
        return response({ acknowledged: true });
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

function privatePort(value: string | undefined, name: string, fallback: number): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) throw new Error(`${name} must be a private TCP port from 1024 to 65535`);
  return port;
}

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
  const network = (name: string, fallback: string) => process.env[`FABRIC_DOCKER_NETWORK_${name}`] ?? fallback;
  // Ephemeral browser containers need only the CDP/worker network (and optional egress). Keeping
  // them off the control network prevents arbitrary page JavaScript from reaching API, scheduler,
  // or broker service addresses.
  const browserNetworks = [network("WORKERS", "browser-fabric-workers")];
  const egressNetwork = network("EGRESS", "browser-fabric-egress");
  // The deployment builds the browser image from this source tree; an assignment's recipe never
  // chooses the image a container runs.
  const browserImage = process.env.FABRIC_BROWSER_IMAGE?.trim();
  const runtimeImageOverrides: Record<string, string> = browserImage ? { chrome: browserImage } : {};
  const production = process.env.NODE_ENV === "production";
  const browserSeccompProfile = process.env.FABRIC_CHROMIUM_SECCOMP_PROFILE?.trim();
  if (production && browserSeccompProfile !== CHROMIUM_SECCOMP_PROFILE_PATH) {
    throw new Error("FABRIC_CHROMIUM_SECCOMP_PROFILE must reference the approved Chromium user-namespace profile in production");
  }
  // Compose passes its project name: stacks sharing a Docker host never reap each other's browsers.
  const deploymentId = process.env.FABRIC_DEPLOYMENT_ID?.trim();
  if (production && !deploymentId) throw new Error("FABRIC_DEPLOYMENT_ID is required in production (the Compose project name)");
  const captchaSolving = await captchaSolvingFromEnvironment(process.env.FABRIC_CAPTCHA_SOLVER_PROXY_URL ?? `http://fabric-egress-sidecar:${egressSidecarListeners.captchaSolver.port}`);
  console.info(`CAPTCHA guardian: ${captchaSolving.models.length > 0 ? "vision model configured" : "no model key (only checkbox, slider and press-and-hold challenges)"}`);
  const browserExecutor = new DockerContainerExecutor({
    ...(deploymentId ? { deploymentId } : {}),
    browserNetworks,
    egressNetwork,
    runtimeImageOverrides,
    // The deployment builds the Fabric images from this source tree (browser-fabric-*:local). The
    // manager accepts only those controller-owned tags (or immutable registry digests), never the
    // image reference carried by an assignment recipe.
    requireImmutableImages: production,
    allowLocalBuildImages: production,
    requireRuntimeImageOverrides: production,
    verifyEgressReady: production,
    browserSeccompProfile,
    requireBrowserSeccompProfile: production,
    volumeHelperImage: process.env.FABRIC_VOLUME_HELPER_IMAGE,
    captchaGuardianFactory: captchaSolving.captchaGuardianFactory,
    tokenSolverFor: captchaSolving.tokenSolverFor,
  });
  const controller = new ManagedWorkerController({ scheduler: runtime.scheduler, browserExecutor });
  const stoppedOrphans = await browserExecutor.stopUntrackedBrowserContainers();
  const releasedLeases = await controller.failUntrackedBrowserLeases();
  if (stoppedOrphans.length > 0 || releasedLeases > 0) {
    console.warn(`Removed ${stoppedOrphans.length} untracked browser container(s) and reclaimed ${releasedLeases} lease(s) after worker-manager restart`);
  }
  const brokerUrl = process.env.FABRIC_INPUT_BROKER_URL;
  const encryptedInputBroker = brokerUrl ? new HttpEncryptedInputBroker({ baseUrl: brokerUrl, serviceName: "fabric-worker-manager", fetch: optionalBrokerFetch(), headers: { "x-fabric-mtls-verified": "true" } }) : undefined;
  const port = privatePort(process.env.PORT, "PORT", 8082);
  const tlsFiles = mtlsFilesFromEnv("FABRIC_WORKER_MANAGER");
  if (production && !tlsFiles) throw new Error("worker-manager requires service mTLS in production");
  const controlServer = Bun.serve({ port, ...(tlsFiles ? { tls: bunMtlsServerTls(tlsFiles) } : {}), fetch: createWorkerManagerFetch({ scheduler: runtime.scheduler, assignmentSigner, ...(encryptedInputBroker ? { encryptedInputBroker } : {}) }) });
  if (process.env.FABRIC_MANAGED_CONTROLLER !== "0") controller.start();
  console.info(`Browser Fabric worker-manager listening on :${port}`);
  const shutdown = () => {
    controlServer.stop();
    void controller.stop().finally(() => runtime.close().finally(() => process.exit(0)));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
