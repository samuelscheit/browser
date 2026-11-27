import type { FabricState } from "./state";
import type { FabricStore } from "./store";
import type { Clock } from "./clock";
import type { SchedulerKernel } from "./scheduler-kernel";
import { FabricError, type Principal, type Profile, type ProjectId, type Worker } from "@browser-fabric/contracts";

export interface SchedulerAdminContext { store: FabricStore; clock: Clock; kernel: SchedulerKernel; }
const now = (clock: Clock) => clock.now().toISOString();

export async function getProfile(context: SchedulerAdminContext, profileRef: Profile["ref"], actor?: Principal): Promise<Profile> {
  return context.store.read((state) => {
    const profile = context.kernel.profile(state, profileRef);
    const registered = context.kernel.authorizeIdentity(state, actor, "read_profile", profileRef);
    if (registered && !registered.roles.includes("fabric_admin") && !registered.projectGrants.some((project) => profile.grants.includes(project))) throw new FabricError("authorization_denied", "principal is not granted access to this profile", 403);
    return structuredClone(profile);
  });
}

export async function listProfiles(context: SchedulerAdminContext, project: ProjectId, actor?: Principal): Promise<Profile[]> {
  return context.store.read((state) => {
    context.kernel.authorizeProject(state, actor, project, "read_profiles", project);
    return [...state.profiles.values()].filter((profile) => profile.grants.includes(project)).map((profile) => structuredClone(profile));
  });
}

export async function listWorkers(context: SchedulerAdminContext, actor?: Principal): Promise<Worker[]> {
  return context.store.read((state) => {
    context.kernel.authorizeFabricAdmin(state, actor, "list_workers", "workers");
    return [...state.workers.values()].map((worker) => structuredClone(worker));
  });
}

export async function getWorker(context: SchedulerAdminContext, workerId: Worker["id"], actor?: Principal): Promise<Worker> {
  return context.store.read((state) => {
    const worker = context.kernel.worker(state, workerId);
    context.kernel.authorizeFabricAdmin(state, actor, "read_worker", workerId);
    return structuredClone(worker);
  });
}

export async function setWorkerHealth(context: SchedulerAdminContext, workerId: Worker["id"], health: Worker["health"], actor?: Principal): Promise<Worker> {
  return context.store.transact((state) => {
    context.kernel.authorizeFabricAdmin(state, actor, "set_worker_health", workerId);
    const worker = context.kernel.worker(state, workerId);
    worker.health = health;
    worker.updatedAt = now(context.clock);
    state.workers.set(worker.id, worker);
    context.kernel.event(state, undefined, { kind: "worker", id: worker.id }, `worker.${health}`, {});
    context.kernel.audit(state, actor, undefined, "worker.health_changed", { kind: "worker", id: worker.id }, "succeeded", { health });
    return structuredClone(worker);
  });
}

export async function revokeProfile(context: SchedulerAdminContext, profileRef: Profile["ref"], actor?: Principal): Promise<Profile> {
  return context.store.transact((state) => {
    const profile = context.kernel.profile(state, profileRef);
    context.kernel.authorizeProject(state, actor, profile.ownerProject, "revoke_profile", profileRef);
    if ([...state.leases.values()].some((lease) => lease.profileRef === profile.ref && lease.status === "active")) throw new FabricError("conflict", "cannot revoke a profile with an active lease", 409);
    profile.status = "revoked";
    profile.updatedAt = now(context.clock);
    state.profiles.set(profile.ref, profile);
    context.kernel.event(state, profile.ownerProject, { kind: "profile", id: profile.ref }, "profile.revoked", {});
    context.kernel.audit(state, actor, profile.ownerProject, "profile.revoked", { kind: "profile", id: profile.ref }, "succeeded", {});
    return structuredClone(profile);
  });
}
