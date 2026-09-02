import type { Worker, WorkerAssignment } from "@browser-fabric/contracts";

/** Outbound worker-control transport. Implementations must use mTLS and never accept inbound commands. */
export interface LocalAgentTransport {
  register(worker: Worker): Promise<void>;
  heartbeat(workerId: Worker["id"]): Promise<void>;
  nextAssignments(workerId: Worker["id"]): Promise<WorkerAssignment[]>;
  claimAssignment(workerId: Worker["id"], assignment: WorkerAssignment): Promise<WorkerAssignment>;
  activeAssignments(workerId: Worker["id"]): Promise<WorkerAssignment[]>;
  heartbeatLease?(workerId: Worker["id"], leaseId: string): Promise<void>;
  takeEncryptedInput?(workerId: Worker["id"], requestId: string): Promise<unknown>;
}

export type { Worker, WorkerAssignment } from "@browser-fabric/contracts";
export * from "./agent";
export * from "./executors";
export * from "./transport";

// The public name in the deployment plan is LocalAgent; the implementation is shared with
// managed outbound agents and enforces the same signed-assignment boundary.
export { FabricWorkerAgent as LocalAgent } from "./agent";
