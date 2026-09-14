import type { Worker, WorkerAssignment } from "@browser-fabric/contracts";
import { buildBrowserProcessSpec, type Executor } from "@browser-fabric/worker-manager";
import type { CdpRelayHandle, LocalAgentTransport } from "./index";

export interface FabricWorkerAgentOptions {
  worker: Worker;
  transport: LocalAgentTransport;
  executor: Executor;
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
  readonly #proxyUrls: readonly string[];
  readonly #pollIntervalMs: number;
  readonly #onAssignmentError?: FabricWorkerAgentOptions["onAssignmentError"];
  readonly #active = new Map<string, { processId: string; relay?: CdpRelayHandle; browserEndpoint?: string; leaseId?: string }>();
  #timer?: ReturnType<typeof setInterval>;
  #ticking = false;
  #stopping = false;

  public constructor(options: FabricWorkerAgentOptions) {
    this.#worker = options.worker;
    this.#transport = options.transport;
    this.#executor = options.executor;
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
      await process.relay?.stop().catch(() => undefined);
      await this.#executor.stop(process.processId).catch(() => undefined);
    }));
  }

  public async tick(): Promise<void> {
    if (this.#ticking || this.#stopping) return;
    this.#ticking = true;
    try {
      await this.#transport.heartbeat(this.#worker.id);
      const active = await this.#transport.activeAssignments(this.#worker.id);
      for (const assignment of active) {
        const identity = assignment.lease?.id ?? assignment.job?.id;
        const process = identity ? this.#active.get(identity) : undefined;
        if (process && this.#executor.isRunning) {
          const running = await Promise.resolve(this.#executor.isRunning(process.processId)).catch(() => false);
          if (!running) {
            await this.#dropLocalLease(assignment, identity!, process, new Error("local browser process exited"));
            continue;
          }
        }
        if (assignment.lease && process && this.#worker.isLocal && process.relay?.connected === false) {
          try {
            await this.#reconnectLocalRelay(assignment, process);
          } catch (error) {
            await this.#dropLocalLease(assignment, identity!, process, error);
            continue;
          }
        }
        if (assignment.lease && process) {
          // Never heartbeat a local browser that lost both its relay and a reconnection attempt.
          // The explicit failure below (or recovery if the manager is unreachable) reclaims it.
          await this.#transport.heartbeatLease?.(this.#worker.id, assignment.lease.id);
        }
      }
      const assignments = await this.#transport.nextAssignments(this.#worker.id);
      for (const assignment of assignments) {
        const identity = assignment.lease?.id ?? assignment.job?.id;
        if (!identity || this.#active.has(identity)) continue;
        if (assignment.recipe.runtime === "media-relay") {
          // Media tasks are manager-owned server work because their result endpoint has access to
          // the Fabric object store. A federated local interactive worker must never receive one.
          await this.#onAssignmentError?.(assignment, new Error("media assignments are not supported by the federated local worker"));
          continue;
        }
        let startedProcess: { processId: string } | undefined;
        let relay: import("./index").CdpRelayHandle | undefined;
        try {
          const claimed = await this.#transport.claimAssignment(this.#worker.id, assignment);
          const spec = buildBrowserProcessSpec(this.#worker, claimed, this.#proxyUrls);
          const started = await this.#executor.start(spec);
          startedProcess = { processId: started.processId };
          // Local workers cannot accept an inbound gateway connection. Open the reverse relay
          // before publishing the readiness transition, so an external client can never obtain
          // a capability whose upstream path is absent.
          if (claimed.lease && this.#worker.isLocal) {
            if (!started.cdpBrowserEndpoint || !this.#transport.openCdpRelay) {
              throw new Error("local browser assignment requires an outbound CDP relay");
            }
            relay = await this.#transport.openCdpRelay(this.#worker.id, claimed.lease.id, started.cdpBrowserEndpoint);
            if (!relay?.connected) throw new Error("local browser CDP relay did not become connected");
          }
          if (claimed.lease && this.#transport.markLeaseStarted) {
            try {
              await this.#transport.markLeaseStarted(this.#worker.id, claimed.lease.id);
            } catch (error) {
              await relay?.stop().catch(() => undefined);
              await this.#executor.stop(started.processId).catch(() => undefined);
              throw error;
            }
          }
          this.#active.set(identity, {
            processId: started.processId,
            ...(relay ? { relay } : {}),
            ...(started.cdpBrowserEndpoint ? { browserEndpoint: started.cdpBrowserEndpoint } : {}),
            ...(claimed.lease ? { leaseId: claimed.lease.id } : {}),
          });
        } catch (error) {
          await relay?.stop().catch(() => undefined);
          if (startedProcess) {
            await this.#executor.stop(startedProcess.processId).catch(() => undefined);
          }
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
        await process.relay?.stop().catch(() => undefined);
        await this.#executor.stop(process.processId).catch(() => undefined);
      }
    } finally {
      this.#ticking = false;
    }
  }

  public activeAssignments(): readonly string[] { return [...this.#active.keys()]; }

  async #reconnectLocalRelay(assignment: WorkerAssignment, process: { processId: string; relay?: CdpRelayHandle; browserEndpoint?: string; leaseId?: string }): Promise<void> {
    const leaseId = assignment.lease?.id;
    if (!leaseId || !process.browserEndpoint || !this.#transport.openCdpRelay) throw new Error("local browser lost its outbound CDP relay and cannot reconnect");
    await process.relay?.stop().catch(() => undefined);
    const relay = await this.#transport.openCdpRelay(this.#worker.id, leaseId, process.browserEndpoint);
    if (!relay?.connected) {
      await relay?.stop().catch(() => undefined);
      throw new Error("local browser CDP relay reconnection did not become connected");
    }
    process.relay = relay;
  }

  async #dropLocalLease(assignment: WorkerAssignment, identity: string, process: { processId: string; relay?: CdpRelayHandle; browserEndpoint?: string; leaseId?: string }, error: unknown): Promise<void> {
    this.#active.delete(identity);
    await process.relay?.stop().catch(() => undefined);
    await this.#executor.stop(process.processId).catch(() => undefined);
    const reason = error instanceof Error ? error.message : "local browser relay failed";
    if (assignment.lease && this.#transport.failLease) await this.#transport.failLease(this.#worker.id, assignment.lease.id, reason).catch(() => undefined);
    await this.#onAssignmentError?.(assignment, error);
  }
}

/**
 * Managed workers are intentionally only heartbeats/registration agents. The controller that has
 * the narrowly scoped Docker socket creates browser containers; these agents never receive Docker
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
