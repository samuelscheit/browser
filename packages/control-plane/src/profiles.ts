import { createHash } from "node:crypto";
import { FabricError, type Profile, type ProfileRef, type Worker, type Principal } from "@browser-fabric/contracts";
import type { BrowserScheduler } from "./scheduler";

export interface VolumeArchive { bytes: Uint8Array; checksum: string; fileCount: number; }
export interface VolumeDriver {
  ensureVolume(worker: Worker, volumeName: string): Promise<void>;
  archive(worker: Worker, volumeName: string): Promise<VolumeArchive>;
  restore(worker: Worker, volumeName: string, archive: VolumeArchive): Promise<void>;
  remove(worker: Worker, volumeName: string): Promise<void>;
  inspect(worker: Worker, volumeName: string): Promise<{ exists: boolean; checksum?: string }>;
}
function validVolumeName(name: string): boolean { return /^[a-z][a-z0-9_.-]{0,127}$/.test(name); }
function checksum(bytes: Uint8Array): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

/** In-memory volume driver used by tests and local development. */
export class MemoryVolumeDriver implements VolumeDriver {
  readonly #volumes = new Map<string, { workerId: string; bytes: Uint8Array }>();
  public async ensureVolume(worker: Worker, volumeName: string): Promise<void> {
    if (!validVolumeName(volumeName)) throw new FabricError("validation_failed", "volume name is invalid", 400);
    const key = `${worker.id}:${volumeName}`;
    if (!this.#volumes.has(key)) this.#volumes.set(key, { workerId: worker.id, bytes: new Uint8Array() });
  }
  public async archive(worker: Worker, volumeName: string): Promise<VolumeArchive> {
    const volume = this.#volumes.get(`${worker.id}:${volumeName}`);
    if (!volume) throw new FabricError("not_found", "profile volume does not exist on worker", 404);
    return { bytes: new Uint8Array(volume.bytes), checksum: checksum(volume.bytes), fileCount: volume.bytes.byteLength ? 1 : 0 };
  }
  public async restore(worker: Worker, volumeName: string, archive: VolumeArchive): Promise<void> {
    await this.ensureVolume(worker, volumeName);
    if (archive.checksum !== checksum(archive.bytes)) throw new FabricError("validation_failed", "volume archive checksum does not match its bytes", 400);
    this.#volumes.set(`${worker.id}:${volumeName}`, { workerId: worker.id, bytes: new Uint8Array(archive.bytes) });
  }
  public async remove(worker: Worker, volumeName: string): Promise<void> { this.#volumes.delete(`${worker.id}:${volumeName}`); }
  public async inspect(worker: Worker, volumeName: string): Promise<{ exists: boolean; checksum?: string }> {
    const volume = this.#volumes.get(`${worker.id}:${volumeName}`);
    return volume ? { exists: true, checksum: checksum(volume.bytes) } : { exists: false };
  }
  public seed(worker: Worker, volumeName: string, bytes: Uint8Array): void { this.#volumes.set(`${worker.id}:${volumeName}`, { workerId: worker.id, bytes: new Uint8Array(bytes) }); }
}

export interface ProfileVolumeManagerOptions {
  scheduler: BrowserScheduler;
  driver: VolumeDriver;
  drainProfile?(profileRef: ProfileRef): Promise<void>;
}

/** Explicit import/relocation workflow with copy verification before affinity changes. */
export class ProfileVolumeManager {
  readonly #scheduler: BrowserScheduler;
  readonly #driver: VolumeDriver;
  readonly #drainProfile: (profileRef: ProfileRef) => Promise<void>;
  public constructor(options: ProfileVolumeManagerOptions) {
    this.#scheduler = options.scheduler;
    this.#driver = options.driver;
    this.#drainProfile = options.drainProfile ?? (async () => undefined);
  }

  public async importProfile(input: { profile: Omit<Profile, "createdAt" | "updatedAt" | "volumeGeneration"> & Partial<Pick<Profile, "createdAt" | "updatedAt" | "volumeGeneration">>; worker: Worker; archive: VolumeArchive; actor?: Principal }): Promise<Profile> {
    if (input.profile.workerId !== input.worker.id) throw new FabricError("validation_failed", "profile worker affinity does not match import worker", 400);
    if (!input.worker.volumeNames.includes(input.profile.volumeName)) throw new FabricError("validation_failed", "profile volume is not declared by worker", 400);
    if (input.archive.checksum !== checksum(input.archive.bytes)) throw new FabricError("validation_failed", "profile archive checksum is invalid", 400);
    await this.#driver.restore(input.worker, input.profile.volumeName, input.archive);
    const inspected = await this.#driver.inspect(input.worker, input.profile.volumeName);
    if (!inspected.exists || inspected.checksum !== input.archive.checksum) throw new FabricError("conflict", "restored profile volume failed checksum verification", 409);
    return this.#scheduler.createProfile(input.profile, input.actor);
  }

  public async cloneProfile(profileRef: ProfileRef, worker: Worker, cloneVolumeName: string): Promise<{ profileRef: ProfileRef; volumeName: string; checksum: string }> {
    const snapshot = await this.#scheduler.store.snapshot();
    const profile = snapshot.profiles.get(profileRef);
    if (!profile) throw new FabricError("not_found", "profile was not found", 404);
    if (profile.workerId !== worker.id) throw new FabricError("validation_failed", "clone worker must equal profile affinity", 400);
    if (!validVolumeName(cloneVolumeName) || !worker.volumeNames.includes(cloneVolumeName)) throw new FabricError("validation_failed", "clone volume is not declared by worker", 400);
    const archive = await this.#driver.archive(worker, profile.volumeName);
    await this.#driver.restore(worker, cloneVolumeName, archive);
    const inspected = await this.#driver.inspect(worker, cloneVolumeName);
    if (inspected.checksum !== archive.checksum) throw new FabricError("conflict", "clone checksum verification failed", 409);
    return { profileRef, volumeName: cloneVolumeName, checksum: archive.checksum };
  }

  public async relocateProfile(profileRef: ProfileRef, targetWorker: Worker, actor?: Principal): Promise<Profile> {
    const snapshot = await this.#scheduler.store.snapshot();
    const profile = snapshot.profiles.get(profileRef);
    if (!profile) throw new FabricError("not_found", "profile was not found", 404);
    const sourceWorker = snapshot.workers.get(profile.workerId);
    if (!sourceWorker) throw new FabricError("not_found", "source worker was not found", 404);
    if (sourceWorker.id === targetWorker.id) throw new FabricError("validation_failed", "target worker must differ from source worker", 400);
    await this.#drainProfile(profileRef);
    const archive = await this.#driver.archive(sourceWorker, profile.volumeName);
    const targetVolume = `${profile.volumeName}-g${profile.volumeGeneration + 1}`;
    if (!targetWorker.volumeNames.includes(targetVolume)) throw new FabricError("validation_failed", "target generation volume is not declared by target worker", 400);
    await this.#driver.restore(targetWorker, targetVolume, archive);
    const inspected = await this.#driver.inspect(targetWorker, targetVolume);
    if (inspected.checksum !== archive.checksum) {
      await this.#driver.remove(targetWorker, targetVolume).catch(() => undefined);
      throw new FabricError("conflict", "relocated profile checksum verification failed", 409);
    }
    try {
      return await this.#scheduler.relocateProfile(profileRef, targetWorker.id, archive.checksum, actor);
    } catch (error) {
      await this.#driver.remove(targetWorker, targetVolume).catch(() => undefined);
      throw error;
    }
  }
}
