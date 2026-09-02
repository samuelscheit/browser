import type { EgressPolicy, Principal, Worker, WorkerAssignment } from "@browser-fabric/contracts";
import { BrowserScheduler } from "@browser-fabric/control-plane";
import { assertRuntimePolicyCompatibility, compileEgressManifest, type EgressManifest } from "@browser-fabric/policy";
import { defaultRuntimeRegistry, type BrowserContainerSpec, type BrowserRuntime } from "@browser-fabric/worker-runtime";

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
}

export interface MediaExecutor {
  start(input: { assignment: WorkerAssignment; worker: Worker; egressPolicy: EgressPolicy }): Promise<{ processId: string }>;
  stop(processId: string): Promise<void>;
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

  public async execute(worker: Worker, assignment: WorkerAssignment, actor: Principal, proxyUrls: readonly string[] = []): Promise<{ processId: string; cdpBrowserEndpoint?: string }> {
    const claimed = await this.scheduler.claimAssignment(worker.id, assignment.lease?.id, assignment.job?.id, actor);
    if (claimed.recipe.runtime === "media-relay") {
      if (!this.mediaExecutor || !claimed.job) throw new Error("media assignment requires a media executor and job");
      return this.mediaExecutor.start({ assignment: claimed, worker, egressPolicy: claimed.egressPolicy });
    }
    const spec = buildBrowserProcessSpec(worker, claimed, proxyUrls, this.#runtimes);
    return this.executor.start(spec);
  }
}
export * from "./docker-executor";
export * from "./controller";
