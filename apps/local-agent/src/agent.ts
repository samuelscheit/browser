import type { Worker, WorkerAssignment } from "@browser-fabric/contracts";
import { buildBrowserProcessSpec, type Executor, type MediaExecutor } from "@browser-fabric/worker-manager";
import type { LocalAgentTransport } from "./index";

export interface FabricWorkerAgentOptions {
  worker: Worker;
  transport: LocalAgentTransport;
  executor: Executor;
  mediaExecutor?: MediaExecutor;
  proxyUrls?: readonly string[];
  pollIntervalMs?: number;
  onAssignmentError?(assignment: WorkerAssignment, error: unknown): Promise<void> | void;
}

/**
 * Outbound-only worker loop shared by the local interactive agent and managed executor agents.
 * It claims signed work before starting anything and keeps one process per lease/job identity.
 */
export class FabricWorkerAgent {
  readonly #worker: Worker;
  readonly #transport: LocalAgentTransport;
  readonly #executor: Executor;
  readonly #mediaExecutor?: MediaExecutor;
  readonly #proxyUrls: readonly string[];
  readonly #pollIntervalMs: number;
  readonly #onAssignmentError?: FabricWorkerAgentOptions["onAssignmentError"];
  readonly #active = new Map<string, { processId: string; media: boolean }>();
  #timer?: ReturnType<typeof setInterval>;
  #ticking = false;
  #stopping = false;

  public constructor(options: FabricWorkerAgentOptions) {
    this.#worker = options.worker;
    this.#transport = options.transport;
    this.#executor = options.executor;
    this.#mediaExecutor = options.mediaExecutor;
    this.#proxyUrls = options.proxyUrls ?? [];
    this.#pollIntervalMs = Math.max(250, Math.min(30_000, options.pollIntervalMs ?? 2_000));
    this.#onAssignmentError = options.onAssignmentError;
  }

  public async start(): Promise<void> {
    this.#stopping = false;
    await this.#transport.register(this.#worker);
    await this.tick();
    this.#timer = setInterval(() => void this.tick(), this.#pollIntervalMs);
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    const active = [...this.#active.entries()];
    this.#active.clear();
    await Promise.all(active.map(async ([, process]) => {
      if (process.media && this.#mediaExecutor) await this.#mediaExecutor.stop(process.processId).catch(() => undefined);
      else await this.#executor.stop(process.processId).catch(() => undefined);
    }));
  }

  public async tick(): Promise<void> {
    if (this.#ticking || this.#stopping) return;
    this.#ticking = true;
    try {
      await this.#transport.heartbeat(this.#worker.id);
      const active = await this.#transport.activeAssignments(this.#worker.id);
      for (const assignment of active) {
        if (assignment.lease) {
          // Lease heartbeat is sent over the same authenticated outbound channel by the
          // transport implementation; stale leases are reclaimed by scheduler.recover().
          await this.#transport.heartbeatLease?.(this.#worker.id, assignment.lease.id);
        }
      }
      const assignments = await this.#transport.nextAssignments(this.#worker.id);
      for (const assignment of assignments) {
        const identity = assignment.lease?.id ?? assignment.job?.id;
        if (!identity || this.#active.has(identity)) continue;
        try {
          const claimed = await this.#transport.claimAssignment(this.#worker.id, assignment);
          if (claimed.recipe.runtime === "media-relay") {
            if (!this.#mediaExecutor) throw new Error("media assignment received without a media executor");
            const started = await this.#mediaExecutor.start({ assignment: claimed, worker: this.#worker, egressPolicy: claimed.egressPolicy });
            this.#active.set(identity, { processId: started.processId, media: true });
          } else {
            const spec = buildBrowserProcessSpec(this.#worker, claimed, this.#proxyUrls);
            const started = await this.#executor.start(spec);
            this.#active.set(identity, { processId: started.processId, media: false });
          }
        } catch (error) {
          await this.#onAssignmentError?.(assignment, error);
        }
      }
      const live = new Set<string>((await this.#transport.activeAssignments(this.#worker.id))
        .map((assignment) => assignment.lease?.id ?? assignment.job?.id)
        .filter((identity): identity is NonNullable<typeof identity> => identity !== undefined)
        .map(String));
      for (const [identity, process] of this.#active) {
        if (live.has(identity)) continue;
        this.#active.delete(identity);
        if (process.media && this.#mediaExecutor) await this.#mediaExecutor.stop(process.processId).catch(() => undefined);
        else await this.#executor.stop(process.processId).catch(() => undefined);
      }
    } finally {
      this.#ticking = false;
    }
  }

  public activeAssignments(): readonly string[] { return [...this.#active.keys()]; }
}

/**
 * Managed workers are intentionally only heartbeats/registration agents. The controller that has
 * the narrowly scoped Swarm socket creates browser services; these agents never receive Docker
 * access and therefore cannot turn an assignment into arbitrary host work.
 */
export class WorkerHeartbeatAgent {
  readonly #worker: Worker;
  readonly #transport: LocalAgentTransport;
  readonly #intervalMs: number;
  #timer?: ReturnType<typeof setInterval>;
  #ticking = false;
  #stopping = false;

  public constructor(options: { worker: Worker; transport: LocalAgentTransport; intervalMs?: number }) {
    this.#worker = options.worker;
    this.#transport = options.transport;
    this.#intervalMs = Math.max(250, Math.min(30_000, options.intervalMs ?? 2_000));
  }

  public async start(): Promise<void> {
    this.#stopping = false;
    await this.#transport.register(this.#worker);
    await this.tick();
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
  }

  public stop(): void {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  public async tick(): Promise<void> {
    if (this.#ticking || this.#stopping) return;
    this.#ticking = true;
    try {
      await this.#transport.heartbeat(this.#worker.id);
    } finally {
      this.#ticking = false;
    }
  }
}
