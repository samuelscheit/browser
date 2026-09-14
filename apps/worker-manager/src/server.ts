import { FabricError, type AttemptId, type Worker } from "@browser-fabric/contracts";
import { ArtifactCollector, ArtifactMediaManifestResolver, AssignmentSigner, bunMtlsServerTls, createBunMtlsFetch, createPostgresScheduler, createProductionObjectStore, HttpEncryptedInputBroker, mtlsFilesFromEnv, type BrowserScheduler, type EncryptedInputBroker, type PostgresSchedulerRuntime } from "@browser-fabric/control-plane";
import { parseWorkerRegistration, workerPrincipal } from "./protocol";
import { ManagedWorkerController } from "./controller";
import { DockerContainerExecutor, DockerMediaContainerExecutor } from "./docker-container-executor";
import { LeasedBrowserProvisioner } from "./leased-browser-provisioner";
import { MediaResultCapabilitySigner, MediaResultGateway } from "./media-result";
import { MediaPlaybackControl } from "./media-playback";

export interface WorkerManagerFetchOptions {
  scheduler: BrowserScheduler;
  assignmentSigner: AssignmentSigner;
  encryptedInputBroker?: EncryptedInputBroker;
  leasedBrowsers?: LeasedBrowserProvisioner;
  mediaPlaybackControl?: MediaPlaybackControl;
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
        const input = await body(request) as { leaseId?: string; jobId?: string };
        const claimed = await options.scheduler.claimAssignment(workerId, input.leaseId as never, input.jobId as never, actor);
        return response(options.assignmentSigner.issue(workerId, claimed));
      }
      if (parts[3] === "leases" && parts[4] && parts[5] === "browser" && request.method === "POST") {
        if (!options.leasedBrowsers) throw new FabricError("not_found", "managed browser provisioning is unavailable", 404);
        const started = await options.leasedBrowsers.start(workerId, decodeURIComponent(parts[4]) as never, actor);
        return response(started, 201);
      }
      if (parts[3] === "leases" && parts[4] && parts[5] === "browser" && request.method === "DELETE") {
        if (!options.leasedBrowsers) throw new FabricError("not_found", "managed browser provisioning is unavailable", 404);
        await options.leasedBrowsers.stop(workerId, decodeURIComponent(parts[4]) as never);
        return new Response(null, { status: 204 });
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
      if (parts[3] === "jobs" && parts[4] && parts[5] === "media-playback-source" && request.method === "POST") {
        if (!options.mediaPlaybackControl) throw new FabricError("not_found", "media playback control is unavailable", 404);
        const input = await body(request) as Record<string, unknown>;
        const attemptId = typeof input.attemptId === "string" && /^attempt_[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(input.attemptId)
          ? input.attemptId as AttemptId
          : undefined;
        const snapshot = await options.scheduler.store.snapshot();
        const job = snapshot.jobs.get(decodeURIComponent(parts[4]) as never);
        if (!job || !attemptId) throw new FabricError("validation_failed", "media playback attemptId is required", 400);
        const result = await options.mediaPlaybackControl.requestSource({ job, worker, attemptId, ...(input.refresh === true ? { refresh: true } : {}) });
        return response(result, 201);
      }
      if (parts[3] === "jobs" && parts[4] && parts[5] === "media-playback-ready" && request.method === "POST") {
        if (!options.mediaPlaybackControl) throw new FabricError("not_found", "media playback control is unavailable", 404);
        const input = await body(request) as Record<string, unknown>;
        const attemptId = typeof input.attemptId === "string" && /^attempt_[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(input.attemptId)
          ? input.attemptId as AttemptId
          : undefined;
        const requestId = typeof input.requestId === "string" && /^input-request_[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(input.requestId)
          ? input.requestId
          : undefined;
        const snapshot = await options.scheduler.store.snapshot();
        const job = snapshot.jobs.get(decodeURIComponent(parts[4]) as never);
        if (!job || !attemptId || !requestId) throw new FabricError("validation_failed", "media playback attemptId and requestId are required", 400);
        await options.mediaPlaybackControl.markReady({ job, worker, attemptId, requestId });
        return response({ acknowledged: true });
      }
      if (parts[3] === "jobs" && parts[4] && parts[5] === "media-playback-fail" && request.method === "POST") {
        const input = await body(request) as Record<string, unknown>;
        const attemptId = typeof input.attemptId === "string" && /^attempt_[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(input.attemptId)
          ? input.attemptId as AttemptId
          : undefined;
        if (!attemptId) throw new FabricError("validation_failed", "media playback attemptId is required", 400);
        const result = await options.scheduler.failMediaTask(decodeURIComponent(parts[4]) as never, worker.id, attemptId, "media playback worker could not activate source", actor);
        return response(result);
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
  const runtimeImageOverrides = Object.fromEntries(
    ([
      ["chromium-cdp", "FABRIC_CHROMIUM_WORKER_IMAGE"],
      ["patchright", "FABRIC_PATCHRIGHT_WORKER_IMAGE"],
      ["rebrowser-puppeteer", "FABRIC_REBROWSER_WORKER_IMAGE"],
      ["companion", "FABRIC_COMPANION_WORKER_IMAGE"],
      // Social's Python worker connects to a separately provisioned browser. Reuse the hardened
      // Chromium browser image; the Python/SocialApi image never needs to contain a browser.
      ["playwright-social", "FABRIC_CHROMIUM_WORKER_IMAGE"],
      ["media-relay", "FABRIC_MEDIA_WORKER_IMAGE"],
    ] as const)
      .map(([runtime, variable]) => [runtime, process.env[variable]?.trim()])
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  const production = process.env.NODE_ENV === "production";
  const browserExecutor = new DockerContainerExecutor({
    browserNetworks,
    egressNetwork,
    runtimeImageOverrides,
    // Compose builds the reviewed Fabric source images locally on fabric-host. The manager accepts
    // only those controller-owned tags (or immutable registry digests), never the image reference
    // carried by an assignment recipe.
    requireImmutableImages: production,
    allowLocalBuildImages: production,
    requireRuntimeImageOverrides: production,
    verifyEgressReady: production,
    volumeHelperImage: process.env.FABRIC_VOLUME_HELPER_IMAGE,
  });
  // Media tasks use the same hardened Docker-container path as browser leases, but must receive the
  // dedicated immutable media image (and helper image policy) rather than the placeholder recipe
  // image.  Keep this override explicit so a media job can never accidentally start a browser
  // runtime or inherit a mutable tag.
  const mediaExecutor = new DockerMediaContainerExecutor({
    browserNetworks,
    egressNetwork,
    runtimeImageOverrides,
    requireImmutableImages: production,
    allowLocalBuildImages: production,
    requireRuntimeImageOverrides: production,
    volumeHelperImage: process.env.FABRIC_VOLUME_HELPER_IMAGE,
  });
  // Only the manager has object-store credentials. The one-shot media service receives a signed
  // result capability and streams bytes back over the private worker overlay; it cannot attach an
  // arbitrary object or derive a storage credential from its assignment.
  const mediaResultPort = privatePort(process.env.FABRIC_MEDIA_RESULT_PORT, "FABRIC_MEDIA_RESULT_PORT", 8083);
  const mediaArtifacts = new ArtifactCollector({ scheduler: runtime.scheduler, objectStore: await createProductionObjectStore() });
  const mediaResultGateway = new MediaResultGateway({
    scheduler: runtime.scheduler,
    artifacts: mediaArtifacts,
    signer: new MediaResultCapabilitySigner(await loadSecret("FABRIC_MEDIA_RESULT_SECRET")),
    resultBaseUrl: process.env.FABRIC_MEDIA_RESULT_BASE_URL ?? `http://fabric-worker-manager:${mediaResultPort}`,
  });
  const mediaPlaybackControl = new MediaPlaybackControl({
    scheduler: runtime.scheduler,
    manifests: new ArtifactMediaManifestResolver({ scheduler: runtime.scheduler, artifacts: mediaArtifacts }),
  });
  const leasedBrowsers = new LeasedBrowserProvisioner({ scheduler: runtime.scheduler, executor: browserExecutor });
  const controller = new ManagedWorkerController({ scheduler: runtime.scheduler, browserExecutor, mediaExecutor, mediaResultGateway });
  const stoppedOrphans = await browserExecutor.stopUntrackedBrowserContainers();
  const stoppedMediaContainers = await mediaExecutor.stopUntrackedMediaContainers();
  const releasedControllerLeases = await controller.failUntrackedBrowserLeases();
  const releasedMediaTasks = await controller.failUntrackedMediaTasks();
  const releasedSocialLeases = await leasedBrowsers.failUntrackedLeases();
  await leasedBrowsers.reconcile();
  if (stoppedOrphans.length > 0 || stoppedMediaContainers.length > 0 || releasedControllerLeases > 0 || releasedMediaTasks > 0 || releasedSocialLeases > 0) {
    console.warn(`Removed ${stoppedOrphans.length} untracked browser container(s), stopped ${stoppedMediaContainers.length} untracked media container(s), and reclaimed ${releasedControllerLeases + releasedMediaTasks + releasedSocialLeases} assignment(s) after worker-manager restart`);
  }
  const brokerUrl = process.env.FABRIC_INPUT_BROKER_URL;
  const encryptedInputBroker = brokerUrl ? new HttpEncryptedInputBroker({ baseUrl: brokerUrl, serviceName: "fabric-worker-manager", fetch: optionalBrokerFetch(), headers: { "x-fabric-mtls-verified": "true" } }) : undefined;
  const port = Number(process.env.PORT ?? 8082);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535 || port === mediaResultPort) throw new Error("PORT must be a distinct private TCP port");
  const tlsFiles = mtlsFilesFromEnv("FABRIC_WORKER_MANAGER");
  if (process.env.NODE_ENV === "production" && !tlsFiles) throw new Error("worker-manager requires service mTLS in production");
  const controlServer = Bun.serve({ port, ...(tlsFiles ? { tls: bunMtlsServerTls(tlsFiles) } : {}), fetch: createWorkerManagerFetch({ scheduler: runtime.scheduler, assignmentSigner, leasedBrowsers, mediaPlaybackControl, ...(encryptedInputBroker ? { encryptedInputBroker } : {}) }) });
  // This listener is intentionally not routed by Traefik and has no mTLS identity headers. Its
  // only accepted operation is a capability-bound media artifact upload from a private service.
  const mediaResultServer = Bun.serve({ port: mediaResultPort, hostname: "0.0.0.0", fetch: (request) => mediaResultGateway.handle(request) });
  // Do not begin any managed assignment until both manager listeners are bound. In particular,
  // a one-shot media service receives a result URL immediately and can finish faster than an
  // asynchronous controller tick; starting it before port 8083 exists loses a valid result.
  if (process.env.FABRIC_MANAGED_CONTROLLER !== "0") controller.start();
  const reconcileLeasedBrowsers = () => void leasedBrowsers.reconcile();
  const leasedBrowserTimer = setInterval(reconcileLeasedBrowsers, 1_000);
  reconcileLeasedBrowsers();
  console.info(`Browser Fabric worker-manager listening on :${port}; private media result gateway on :${mediaResultPort}`);
  const shutdown = () => {
    clearInterval(leasedBrowserTimer);
    mediaResultServer.stop();
    controlServer.stop();
    void leasedBrowsers.stopAll().finally(() => controller.stop().finally(() => runtime.close().finally(() => process.exit(0))));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
