import type { EgressPolicy, Principal, Worker, WorkerAssignment } from "@browser-fabric/contracts";
import { BrowserScheduler } from "@browser-fabric/control-plane";
import { assertRuntimePolicyCompatibility, compileEgressManifest, type EgressManifest } from "@browser-fabric/policy";
import { defaultRuntimeRegistry, type BrowserContainerSpec, type BrowserRuntime } from "@browser-fabric/worker-runtime";
import type { PreparedMediaRelay } from "./media-result";

export interface BrowserProcessSpec {
  assignment: WorkerAssignment;
  container: BrowserContainerSpec;
  cdpInternalEndpoint?: string;
  profileVolume?: string;
  egress: EgressManifest;
  resourceLimits: Worker["resourceLimits"];
  security: {
    dockerSocketMounted: false;
    hostHomeMounted: false;
    repositoryMounted: false;
    applicationSecretsMounted: false;
  };
}

export interface Executor {
  start(spec: BrowserProcessSpec): Promise<{ processId: string; cdpBrowserEndpoint?: string }>;
  stop(processId: string): Promise<void>;
  /** Optional liveness probe used to detect a crashed browser before heartbeating its lease. */
  isRunning?(processId: string): Promise<boolean> | boolean;
}

export interface MediaExecutor {
  start(input: { assignment: WorkerAssignment; worker: Worker; egressPolicy: EgressPolicy; relay: PreparedMediaRelay }): Promise<{ processId: string }>;
  stop(processId: string): Promise<void>;
  /** Optional completion stream for one-shot media jobs. */
  wait?(processId: string, timeoutMs?: number): Promise<{ status: "succeeded" | "failed"; result?: Record<string, unknown>; reason?: string }>;
  isRunning?(processId: string): Promise<boolean> | boolean;
}

/** Compile a signed/claimed assignment into the only launch surface executors may receive. */
export function buildBrowserProcessSpec(worker: Worker, claimed: WorkerAssignment, proxyUrls: readonly string[] = [], runtimes: ReadonlyMap<string, BrowserRuntime> = defaultRuntimes()): BrowserProcessSpec {
  if (claimed.recipe.runtime === "media-relay") throw new Error("media assignments do not have browser process specs");
  assertRuntimePolicyCompatibility(claimed.recipe.runtime, claimed.egressPolicy);
  const runtime = runtimes.get(claimed.recipe.runtime);
  if (!runtime) throw new Error(`no worker runtime registered for ${claimed.recipe.runtime}`);
  const container = runtime.buildSpec(claimed, worker, claimed.egressPolicy);
  return {
    assignment: claimed,
    container,
    ...(claimed.lease?.internalCdpEndpoint === undefined ? {} : { cdpInternalEndpoint: claimed.lease.internalCdpEndpoint }),
    ...(container.volumes[0] ? { profileVolume: container.volumes[0].source } : {}),
    egress: compileEgressManifest(claimed.egressPolicy, proxyUrls),
    resourceLimits: worker.resourceLimits,
    security: { dockerSocketMounted: false, hostHomeMounted: false, repositoryMounted: false, applicationSecretsMounted: false }
  };
}

function defaultRuntimes(): ReadonlyMap<string, BrowserRuntime> {
  const registry = defaultRuntimeRegistry();
  return new Map(registry.list().map((family) => [family, registry.get(family)]));
}

/** Validates a worker allocation before any runtime starts. */
export class WorkerManager {
  readonly #runtimes: Map<string, BrowserRuntime>;
  public constructor(readonly scheduler: BrowserScheduler, readonly executor: Executor, readonly mediaExecutor?: MediaExecutor, runtimes: readonly BrowserRuntime[] = []) {
    const registry = defaultRuntimeRegistry();
    for (const runtime of runtimes) registry.register(runtime);
    this.#runtimes = new Map(registry.list().map((family) => [family, registry.get(family)]));
  }

  public async claim(worker: Worker, assignment: WorkerAssignment, actor: Principal): Promise<WorkerAssignment> {
    return this.scheduler.claimAssignment(worker.id, assignment.lease?.id, assignment.job?.id, actor);
  }

  /** Start an already claimed assignment. Media work requires a manager-issued artifact handoff. */
  public async startClaimed(worker: Worker, claimed: WorkerAssignment, proxyUrls: readonly string[] = [], relay?: PreparedMediaRelay): Promise<{ processId: string; cdpBrowserEndpoint?: string }> {
    if (claimed.recipe.runtime === "media-relay") {
      if (!this.mediaExecutor || !claimed.job) throw new Error("media assignment requires a media executor and job");
      if (!relay) throw new Error("media assignment requires a manager-issued artifact handoff");
      return this.mediaExecutor.start({ assignment: claimed, worker, egressPolicy: claimed.egressPolicy, relay });
    }
    const spec = buildBrowserProcessSpec(worker, claimed, proxyUrls, this.#runtimes);
    return this.executor.start(spec);
  }

  /** Convenience for browser assignments. Media callers must claim then prepare a handoff first. */
  public async execute(worker: Worker, assignment: WorkerAssignment, actor: Principal, proxyUrls: readonly string[] = []): Promise<{ processId: string; cdpBrowserEndpoint?: string }> {
    const claimed = await this.claim(worker, assignment, actor);
    return this.startClaimed(worker, claimed, proxyUrls);
  }
}
export * from "./docker-container-executor";
export * from "./captcha-solver-factory";
export * from "./controller";
export * from "./media-result";
export * from "./media-playback";
