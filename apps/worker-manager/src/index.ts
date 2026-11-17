import type { Principal, Worker, WorkerAssignment } from "@browser-fabric/contracts";
import { BrowserScheduler } from "@browser-fabric/control-plane";
import { defaultRuntimeRegistry, type BrowserContainerSpec, type BrowserRuntime } from "@browser-fabric/worker-runtime";

export interface BrowserProcessSpec {
  assignment: WorkerAssignment;
  container: BrowserContainerSpec;
  cdpInternalEndpoint?: string;
  profileVolume?: string;
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

/** Compile a signed/claimed assignment into the only launch surface executors may receive. */
export function buildBrowserProcessSpec(worker: Worker, claimed: WorkerAssignment, runtimes: ReadonlyMap<string, BrowserRuntime> = defaultRuntimes()): BrowserProcessSpec {
  const runtime = runtimes.get(claimed.recipe.runtime);
  if (!runtime) throw new Error(`no worker runtime registered for ${claimed.recipe.runtime}`);
  const container = runtime.buildSpec(claimed, worker, claimed.egressPolicy);
  return {
    assignment: claimed,
    container,
    ...(claimed.lease.internalCdpEndpoint === undefined ? {} : { cdpInternalEndpoint: claimed.lease.internalCdpEndpoint }),
    ...(container.volumes[0] ? { profileVolume: container.volumes[0].source } : {}),
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
  public constructor(readonly scheduler: BrowserScheduler, readonly executor: Executor, runtimes: readonly BrowserRuntime[] = []) {
    const registry = defaultRuntimeRegistry();
    for (const runtime of runtimes) registry.register(runtime);
    this.#runtimes = new Map(registry.list().map((family) => [family, registry.get(family)]));
  }

  public async claim(worker: Worker, assignment: WorkerAssignment, actor: Principal): Promise<WorkerAssignment> {
    return this.scheduler.claimAssignment(worker.id, assignment.lease.id, actor);
  }

  /** Start an already claimed assignment. */
  public async startClaimed(worker: Worker, claimed: WorkerAssignment): Promise<{ processId: string; cdpBrowserEndpoint?: string }> {
    return this.executor.start(buildBrowserProcessSpec(worker, claimed, this.#runtimes));
  }

  public async execute(worker: Worker, assignment: WorkerAssignment, actor: Principal): Promise<{ processId: string; cdpBrowserEndpoint?: string }> {
    return this.startClaimed(worker, await this.claim(worker, assignment, actor));
  }
}
export * from "./docker-container-executor";
export * from "./captcha-solver-factory";
export * from "./controller";
