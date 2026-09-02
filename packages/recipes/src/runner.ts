import { FabricError, type Artifact, type JobId, type Job, type Principal, type Worker } from "@browser-fabric/contracts";
import type { BrowserScheduler, ArtifactCollector } from "@browser-fabric/control-plane";
import type { RecipeDefinition, RecipeRegistry } from "./index";

export type RecipeExecutionStatus = "succeeded" | "failed" | "blocked_challenge" | "awaiting_manual" | "auth_required";

export interface RecipeExecutionArtifact {
  kind: Artifact["kind"];
  contentType: string;
  bytes: Uint8Array;
  label?: string;
}

export interface RecipeExecutionResult {
  status: RecipeExecutionStatus;
  result?: Record<string, unknown>;
  reason?: string;
  artifacts?: readonly RecipeExecutionArtifact[];
  retryable?: boolean;
}

export interface RecipeExecutionContext {
  job: Job;
  recipe: RecipeDefinition;
  worker: Worker;
  signal: AbortSignal;
  /** Input values must be requested from the Fabric ephemeral channel, never read from job.operation. */
  requestInput(field: string, fieldType: "password" | "otp" | "captcha_provider_credential" | "proxy_credential" | "form_value"): Promise<string>;
}

export interface RecipeExecutor {
  execute(context: RecipeExecutionContext): Promise<RecipeExecutionResult>;
}

export interface RecipeRunnerOptions {
  scheduler: BrowserScheduler;
  registry: RecipeRegistry;
  executorFor(recipe: RecipeDefinition): RecipeExecutor;
  artifactCollector?: ArtifactCollector;
  /** Production adapters may decrypt an envelope on the worker instead of using the local vault. */
  consumeInput?(input: { requestId: string; job: Job; worker: Worker }): Promise<string>;
}

/**
 * Common typed-job orchestration. It preserves normalized challenge/manual/auth states and only
 * retries failures explicitly marked retryable by the recipe implementation.
 */
export class RecipeRunner {
  readonly #scheduler: BrowserScheduler;
  readonly #registry: RecipeRegistry;
  readonly #executorFor: RecipeRunnerOptions["executorFor"];
  readonly #artifactCollector?: ArtifactCollector;
  readonly #consumeInput?: RecipeRunnerOptions["consumeInput"];
  readonly #abortControllers = new Map<JobId, AbortController>();

  public constructor(options: RecipeRunnerOptions) {
    this.#scheduler = options.scheduler;
    this.#registry = options.registry;
    this.#executorFor = options.executorFor;
    this.#artifactCollector = options.artifactCollector;
    this.#consumeInput = options.consumeInput;
  }

  public async run(jobId: JobId, worker: Worker, actor: Principal): Promise<RecipeExecutionResult> {
    const snapshot = await this.#scheduler.store.snapshot();
    const job = snapshot.jobs.get(jobId);
    if (!job) throw new FabricError("not_found", `job ${jobId} was not found`, 404);
    if (job.status !== "running") throw new FabricError("invalid_state", `job is ${job.status}, not running`, 409);
    if (job.workerId !== worker.id) throw new FabricError("authorization_denied", "job is assigned to another worker", 403);
    const workerActor: Principal = {
      ...actor,
      certificateFingerprint: worker.certificateFingerprint,
      roles: actor.roles
    };
    const recipe = this.#registry.get(job.recipeRef as never);
    const controller = new AbortController();
    this.#abortControllers.set(jobId, controller);
    try {
      const executor = this.#executorFor(recipe);
      let latest: RecipeExecutionResult = { status: "failed", reason: "recipe executor did not run" };
      for (let attempt = 1; attempt <= recipe.maxAttempts; attempt += 1) {
        if (controller.signal.aborted) {
          await this.#scheduler.cancelJob(jobId, actor);
          return { status: "failed", reason: "recipe execution was cancelled" };
        }
        const current = (await this.#scheduler.store.snapshot()).jobs.get(jobId);
        if (!current || current.status === "cancelled") return { status: "failed", reason: "job was cancelled" };
        try {
          latest = await executor.execute({
            job: structuredClone(current),
            recipe,
            worker,
            signal: controller.signal,
            requestInput: async (field, fieldType) => {
              if (!current.leaseId) throw new FabricError("invalid_state", "typed browser job has no active lease", 409);
              const request = await this.#scheduler.requestEphemeralInput({ jobId, leaseId: current.leaseId, field, fieldType }, workerActor);
              return this.#consumeInput
                ? this.#consumeInput({ requestId: request.request.id, job: current, worker })
                : this.#scheduler.awaitEphemeralInput(request.request.id, { actor: workerActor, signal: controller.signal });
            }
          });
        } catch (error) {
          if (error instanceof FabricError && error.code === "invalid_state" && (await this.#scheduler.getJob(jobId, actor)).status === "cancelled") return { status: "failed", reason: "job was cancelled" };
          latest = { status: "failed", reason: error instanceof Error ? error.message : "recipe executor failed", retryable: true };
        }
        for (const artifact of latest.artifacts ?? []) {
          if (!this.#artifactCollector) continue;
          await this.#artifactCollector.capture({ project: current.project, jobId, kind: artifact.kind, contentType: artifact.contentType, bytes: artifact.bytes, policy: this.#registry.getArtifactPolicy(current.artifactPolicyRef as never), ...(artifact.label === undefined ? {} : { label: artifact.label }) });
        }
        if (latest.status === "succeeded") {
          await this.#scheduler.completeJob(jobId, latest.result ?? {}, workerActor);
          return latest;
        }
        if (latest.status === "awaiting_manual" || latest.status === "blocked_challenge" || latest.status === "auth_required") {
          await this.#scheduler.failJob(jobId, latest.status, latest.reason ?? latest.status, workerActor);
          return latest;
        }
        if (!latest.retryable || attempt === recipe.maxAttempts) break;
        await this.#scheduler.beginJobRetry(jobId, workerActor);
      }
      await this.#scheduler.failJob(jobId, "failed", latest.reason ?? "recipe failed", workerActor);
      return latest;
    } finally {
      this.#abortControllers.delete(jobId);
    }
  }

  public cancel(jobId: JobId): void { this.#abortControllers.get(jobId)?.abort(); }
}
