import { spawn } from "node:child_process";
import { FabricError, MEDIA_SOURCE_MAX_BYTES } from "@browser-fabric/contracts";
import { assertFailClosedPac, internalEgressProxyUrl } from "@browser-fabric/policy";
import {
  assertTurnstileGuardianSpec,
  defaultTurnstileGuardianFactory,
  type TurnstileGuardianFactory,
  type TurnstileGuardianHandle,
} from "@browser-fabric/worker-runtime";
import type { BrowserProcessSpec, Executor, MediaExecutor } from "./index";

/** Narrow, argv-only boundary around the privileged Docker CLI. */
export interface DockerCommand {
  run(args: readonly string[], options?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/** `docker` is always invoked with argv rather than a shell command. */
export class ChildProcessDockerCommand implements DockerCommand {
  public async run(args: readonly string[], options: { timeoutMs?: number } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const child = spawn("docker", [...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new FabricError("worker_unavailable", "Docker command timed out", 503));
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new FabricError("worker_unavailable", `Docker command failed to start: ${error.message}`, 503));
      });
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode: exitCode ?? 1, stdout, stderr });
      });
    });
  }
}

export interface DockerContainerExecutorOptions {
  command?: DockerCommand;
  /** Fetch implementation used from the manager network to prove browser readiness. */
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Controller-owned runtime images. Recipe image metadata never chooses an image at runtime. */
  runtimeImageOverrides?: Readonly<Record<string, string>>;
  /** Reject any launch whose runtime has no controller-owned override. */
  requireRuntimeImageOverrides?: boolean;
  /** Permit immutable registry images only unless a Compose-built local tag is explicitly allowed. */
  requireImmutableImages?: boolean;
  /** Compose builds these reviewed source images locally on the Fabric host. */
  allowLocalBuildImages?: boolean;
  browserNetworks?: readonly string[];
  egressNetwork?: string;
  containerPrefix?: string;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Pinned helper image used only to make and verify disposable profile copies. */
  volumeHelperImage?: string;
  volumeCopyTimeoutMs?: number;
  browserReadyTimeoutMs?: number;
  /** Production validates the exact fail-closed PAC before a browser container starts. */
  verifyEgressReady?: boolean;
  egressReadyTimeoutMs?: number;
  /** Extra allowlisted environment keys supplied by a runtime image, never client values. */
  allowedEnvironmentKeys?: readonly string[];
  /** Factory boundary for the mandatory browser-level companion; production uses real CDP. */
  turnstileGuardianFactory?: TurnstileGuardianFactory;
}

const safeContainerName = /^[a-z][a-z0-9_-]{0,62}$/;
const safeVolume = /^[a-z][a-z0-9_.-]{0,127}$/;
const safeWorkerId = /^worker_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const safeAssignmentId = /^(?:browser-lease|job)_[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const safeNetworkName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const localFabricImage = /^browser-fabric-[a-z][a-z0-9-]{0,62}:local$/;
const immutableImage = /^.+@sha256:[a-f0-9]{64}$/i;
const forbiddenEnv = /(PASSWORD|SECRET|TOKEN|COOKIE|CREDENTIAL|AUTHORIZATION|OTP|MS_TOKEN)/i;
const forbiddenArg = /(^|\s)(--no-sandbox|--disable-web-security)(\s|$)/;

function containerName(prefix: string, id: string): string {
  const value = `${prefix}-${id}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63).replace(/-+$/, "");
  if (!safeContainerName.test(value)) throw new FabricError("validation_failed", "generated Docker container name is invalid", 400);
  return value;
}

function assertImage(image: string, input: { requireImmutable?: boolean; allowLocalBuildImages?: boolean } = {}): void {
  if (!image || image.length > 512 || /\s/.test(image) || image.endsWith(":latest") || (image.includes("@sha256:") && !immutableImage.test(image))) {
    throw new FabricError("validation_failed", "browser image must be a pinned, non-latest image reference", 400);
  }
  if (input.requireImmutable && !immutableImage.test(image) && !(input.allowLocalBuildImages && localFabricImage.test(image))) {
    throw new FabricError("validation_failed", "production browser image must be an immutable digest or a reviewed Compose local build", 400);
  }
}

function assertVolumeName(name: string): void {
  if (!safeVolume.test(name)) throw new FabricError("validation_failed", "Docker volume name is invalid", 400);
}

function assertNetworkName(name: string): void {
  if (!safeNetworkName.test(name)) throw new FabricError("validation_failed", "Docker network name is invalid", 400);
}

function assertSpec(spec: BrowserProcessSpec, allowedEnvironmentKeys: ReadonlySet<string>): void {
  if (spec.container.security.dockerSocketMounted || spec.container.security.hostHomeMounted || spec.container.security.repositoryMounted || spec.container.security.applicationSecretsMounted) {
    throw new FabricError("validation_failed", "browser container security invariants were violated", 400);
  }
  if (!safeWorkerId.test(spec.container.workerId)) throw new FabricError("validation_failed", "browser worker identity is invalid", 400);
  if (spec.container.leaseId && !safeAssignmentId.test(spec.container.leaseId)) throw new FabricError("validation_failed", "browser lease identity is invalid", 400);
  if (spec.container.jobId && !safeAssignmentId.test(spec.container.jobId)) throw new FabricError("validation_failed", "browser job identity is invalid", 400);
  if (!spec.container.networks.includes("fabric-workers") || spec.container.networks.some((network) => network !== "fabric-workers" && network !== "fabric-egress")) {
    throw new FabricError("validation_failed", "browser container may join only Fabric worker and egress networks", 400);
  }
  if (spec.container.cdpBind.host === "127.0.0.1" && spec.container.cdpBind.port === 0) throw new FabricError("validation_failed", "browser CDP port is invalid", 400);
  if (spec.container.cdpBind.port !== 0 && (spec.container.cdpBind.host !== "private-overlay" || spec.container.cdpBind.port < 1024 || spec.container.cdpBind.port > 65_535)) {
    throw new FabricError("validation_failed", "browser CDP must bind to a private worker network port", 400);
  }
  if (spec.container.cdpBind.port !== 0) {
    if (!spec.container.turnstileGuardian) throw new FabricError("validation_failed", "every Fabric browser must declare the Turnstile guardian", 400);
    try { assertTurnstileGuardianSpec(spec.container.turnstileGuardian); }
    catch (error) { throw new FabricError("validation_failed", error instanceof Error ? error.message : "invalid Turnstile guardian", 400); }
  }
  if (spec.container.command.length < 1 || spec.container.command.length > 64 || spec.container.command.some((arg) => arg.length > 4_096 || /[\0\r\n]/.test(arg) || forbiddenArg.test(arg))) {
    throw new FabricError("validation_failed", "browser command contains a forbidden or malformed argument", 400);
  }
  for (const [key, value] of Object.entries(spec.container.environment)) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || forbiddenEnv.test(key) || (!allowedEnvironmentKeys.has(key) && key.startsWith("APP_"))) {
      throw new FabricError("secret_rejected", `environment key ${key} is not permitted in a browser container`, 400);
    }
    if (value.length > 4_096 || /[\0\r\n]/.test(value)) throw new FabricError("validation_failed", `environment value for ${key} is malformed`, 400);
  }
  for (const volume of spec.container.volumes) {
    if (!safeVolume.test(volume.source) || !volume.target.startsWith("/fabric/") || volume.target.includes("..")) {
      throw new FabricError("validation_failed", "browser container may mount only declared named volumes under /fabric", 400);
    }
  }
  if (spec.container.volumes.filter((volume) => volume.target === "/fabric/profile").length > 1) {
    throw new FabricError("validation_failed", "browser container may mount only one profile volume", 400);
  }
}

function temporaryVolumeLabel(volumes: readonly string[]): string | undefined {
  const unique = [...new Set(volumes)];
  if (unique.length === 0) return undefined;
  for (const volume of unique) assertVolumeName(volume);
  return unique.join(",");
}

/** Docker's `--mount` defaults to read/write; spell only the supported readonly option. */
function volumeMount(source: string, destination: string, readOnly = false): string {
  return `type=volume,source=${source},destination=${destination}${readOnly ? ",readonly" : ""}`;
}

function createArgs(spec: BrowserProcessSpec, name: string, primaryNetwork: string, temporaryVolumes: readonly string[]): string[] {
  const container = spec.container;
  assertNetworkName(primaryNetwork);
  const temporary = temporaryVolumeLabel(temporaryVolumes);
  const args = [
    "container", "create",
    "--name", name,
    "--network", primaryNetwork,
    "--restart", "no",
    "--stop-timeout", "10",
    "--label", "com.browser-fabric.managed=true",
    "--label", `com.browser-fabric.kind=${container.cdpBind.port === 0 ? "media" : "browser"}`,
    "--label", `com.browser-fabric.worker-id=${container.workerId}`,
    ...(temporary === undefined ? [] : ["--label", `com.browser-fabric.temporary-volumes=${temporary}`]),
    ...(container.leaseId ? ["--label", `com.browser-fabric.lease-id=${container.leaseId}`] : []),
    ...(container.jobId ? ["--label", `com.browser-fabric.job-id=${container.jobId}`] : []),
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--cpus", String(Math.max(0.1, container.limits.cpuMilli / 1_000)),
    "--memory", `${container.limits.memoryMiB}m`,
    "--pids-limit", String(container.limits.pids),
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=1073741824",
    "--shm-size", `${container.limits.shmMiB}m`,
  ];
  for (const volume of container.volumes) {
    args.push("--mount", volumeMount(volume.source, volume.target, volume.readOnly));
  }
  for (const [key, value] of Object.entries(container.environment)) args.push("--env", `${key}=${value}`);
  args.push(container.image, ...container.command);
  return args;
}

/**
 * Trusted controller-side Docker-container executor.  The manager is the only
 * component with the Docker socket; every lease becomes an ordinary bounded
 * Docker container on the private Compose networks rather than a Swarm service.
 */
export class DockerContainerExecutor implements Executor {
  readonly #command: DockerCommand;
  readonly #fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly #options: Required<Pick<DockerContainerExecutorOptions, "browserNetworks" | "containerPrefix">> & Omit<DockerContainerExecutorOptions, "browserNetworks" | "containerPrefix">;
  readonly #containers = new Map<string, string>();
  readonly #starting = new Map<string, Promise<{ processId: string; cdpBrowserEndpoint?: string }>>();
  readonly #guardians = new Map<string, TurnstileGuardianHandle>();
  readonly #temporaryVolumesByContainer = new Map<string, { workerId: string; volumes: string[] }>();
  readonly #turnstileGuardianFactory: TurnstileGuardianFactory;

  public constructor(options: DockerContainerExecutorOptions = {}) {
    this.#command = options.command ?? new ChildProcessDockerCommand();
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#turnstileGuardianFactory = options.turnstileGuardianFactory ?? defaultTurnstileGuardianFactory;
    this.#options = {
      browserNetworks: options.browserNetworks ?? ["browser-fabric-workers"],
      containerPrefix: options.containerPrefix ?? "fabric-browser",
      requireImmutableImages: options.requireImmutableImages ?? process.env.NODE_ENV === "production",
      requireRuntimeImageOverrides: options.requireRuntimeImageOverrides ?? process.env.NODE_ENV === "production",
      ...options,
    };
    for (const network of this.#options.browserNetworks) assertNetworkName(network);
    if (this.#options.egressNetwork) assertNetworkName(this.#options.egressNetwork);
  }

  public async start(spec: BrowserProcessSpec): Promise<{ processId: string; cdpBrowserEndpoint?: string }> {
    const runtime = spec.assignment.recipe.runtime;
    const override = this.#options.runtimeImageOverrides?.[runtime];
    if (this.#options.requireRuntimeImageOverrides && !override) {
      throw new FabricError("worker_unavailable", `no controller-owned Docker image is configured for runtime ${runtime}`, 503);
    }
    const effectiveSpec = override ? { ...spec, container: { ...spec.container, image: override } } : spec;
    assertSpec(effectiveSpec, new Set(this.#options.allowedEnvironmentKeys ?? []));
    assertImage(effectiveSpec.container.image, {
      requireImmutable: this.#options.requireImmutableImages,
      allowLocalBuildImages: this.#options.allowLocalBuildImages,
    });
    if (this.#options.verifyEgressReady && effectiveSpec.container.cdpBind.port !== 0) {
      await this.#verifyEgressReady(effectiveSpec, this.#options.egressReadyTimeoutMs ?? this.#options.startupTimeoutMs ?? 30_000);
    }
    const identity = effectiveSpec.container.leaseId ?? effectiveSpec.container.jobId;
    if (!identity || !safeAssignmentId.test(identity)) throw new FabricError("validation_failed", "browser container requires a valid lease or job identity", 400);
    const name = containerName(this.#options.containerPrefix, identity);
    const pending = this.#starting.get(identity);
    if (pending) return pending;
    if (this.#containers.has(identity)) throw new FabricError("conflict", "browser container already exists for this assignment", 409);
    const task = this.#startEffective(effectiveSpec, identity, name);
    this.#starting.set(identity, task);
    try {
      return await task;
    } finally {
      if (this.#starting.get(identity) === task) this.#starting.delete(identity);
    }
  }

  async #startEffective(spec: BrowserProcessSpec, identity: string, name: string): Promise<{ processId: string; cdpBrowserEndpoint?: string }> {
    const temporaryVolumes: string[] = [];
    let created = false;
    try {
      await this.#prepareVolumes(spec, name, temporaryVolumes);
      const primaryNetwork = this.#options.browserNetworks[0];
      if (!primaryNetwork) throw new FabricError("worker_unavailable", "no Fabric worker network is configured", 503);
      const createdContainer = await this.#command.run(createArgs(spec, name, primaryNetwork, temporaryVolumes), { timeoutMs: this.#options.startupTimeoutMs ?? 30_000 });
      if (createdContainer.exitCode !== 0) throw new FabricError("worker_unavailable", `Docker could not create browser container (${createdContainer.stderr.slice(0, 500)})`, 503);
      created = true;
      for (const network of this.#runtimeNetworks(spec).filter((network) => network !== primaryNetwork)) {
        const connected = await this.#command.run(["network", "connect", network, name], { timeoutMs: this.#options.startupTimeoutMs ?? 30_000 });
        if (connected.exitCode !== 0) throw new FabricError("worker_unavailable", `Docker could not attach browser container to its private network (${connected.stderr.slice(0, 500)})`, 503);
      }
      const started = await this.#command.run(["container", "start", name], { timeoutMs: this.#options.startupTimeoutMs ?? 30_000 });
      if (started.exitCode !== 0) throw new FabricError("worker_unavailable", `Docker could not start browser container (${started.stderr.slice(0, 500)})`, 503);
      this.#containers.set(identity, name);
      this.#temporaryVolumesByContainer.set(name, { workerId: spec.container.workerId, volumes: temporaryVolumes });

      if (spec.container.cdpBind.port !== 0) {
        const endpoint = this.#browserEndpoint(name, spec.container.cdpBind.port);
        await this.#waitForBrowserReady(endpoint, this.#options.browserReadyTimeoutMs ?? this.#options.startupTimeoutMs ?? 30_000);
        if (this.#containers.get(identity) !== name) throw new FabricError("worker_unavailable", "browser container was stopped while becoming ready", 503);
        const guardianSpec = spec.container.turnstileGuardian;
        if (!guardianSpec) throw new Error("Fabric browser has no Turnstile guardian specification");
        const guardian = this.#turnstileGuardianFactory({ endpoint, spec: guardianSpec });
        this.#guardians.set(name, guardian);
        await guardian.start();
        if (this.#containers.get(identity) !== name || this.#guardians.get(name) !== guardian) {
          await guardian.stop().catch(() => undefined);
          throw new FabricError("worker_unavailable", "browser container was stopped while its Turnstile guardian was starting", 503);
        }
        if (!guardian.snapshot.running) throw new FabricError("worker_unavailable", "Turnstile guardian did not become ready", 503);
      }
    } catch (error) {
      if (created) await this.#stopContainer(name, { workerId: spec.container.workerId, volumes: temporaryVolumes }).catch(() => undefined);
      else await this.#removeTemporaryVolumes(temporaryVolumes).catch(() => undefined);
      throw error;
    }
    return {
      processId: name,
      ...(spec.container.cdpBind.port === 0 ? {} : { cdpBrowserEndpoint: this.#browserEndpoint(name, spec.container.cdpBind.port) }),
    };
  }

  public async stop(processId: string): Promise<void> {
    const pending = this.#pendingStartForContainer(processId);
    if (pending) await pending.catch(() => undefined);
    if (!this.#hasContainer(processId) && !this.#guardians.has(processId) && !this.#temporaryVolumesByContainer.has(processId)) return;
    await this.#stopContainer(processId);
  }

  /** Remove a labelled container discovered during manager-start recovery. */
  public async removeUntrackedContainer(processId: string): Promise<void> {
    if (!safeContainerName.test(processId)) throw new FabricError("worker_unavailable", "Docker returned an invalid managed container name", 503);
    await this.#stopContainer(processId);
  }

  public async isRunning(processId: string): Promise<boolean> {
    if (!this.#hasContainer(processId)) return false;
    const guardian = this.#guardians.get(processId);
    if (guardian && !guardian.snapshot.running) return false;
    const inspected = await this.#command.run(["container", "inspect", "--format", "{{.State.Running}}", processId], { timeoutMs: 10_000 }).catch(() => undefined);
    return inspected?.exitCode === 0 && inspected.stdout.trim() === "true";
  }

  public async stopAll(): Promise<void> {
    await Promise.all([...this.#starting.values()].map((starting) => starting.catch(() => undefined)));
    const containers = new Set([...this.#containers.values(), ...this.#guardians.keys(), ...this.#temporaryVolumesByContainer.keys()]);
    await Promise.all([...containers].map((name) => this.stop(name)));
  }

  /**
   * A manager restart loses its in-memory guardian handles. Stop every labelled
   * browser container before reclaiming durable assignments so a stale browser
   * can never outlive guardian ownership.
   */
  public async stopUntrackedBrowserContainers(): Promise<readonly string[]> {
    const listed = await this.#command.run([
      "container", "ls", "--all", "--filter", "label=com.browser-fabric.lease-id", "--format", "{{.Names}}",
    ], { timeoutMs: this.#options.stopTimeoutMs ?? 20_000 });
    if (listed.exitCode !== 0) throw new FabricError("worker_unavailable", `Docker could not list prior browser containers (${listed.stderr.slice(0, 500)})`, 503);
    const containers = [...new Set(listed.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean))];
    for (const name of containers) {
      if (!safeContainerName.test(name)) throw new FabricError("worker_unavailable", "Docker returned an invalid managed browser container name", 503);
      await this.#stopContainer(name, await this.#untrackedCleanupMetadata(name));
    }
    return containers;
  }

  public containerFor(identity: string): string | undefined { return this.#containers.get(identity); }

  #hasContainer(processId: string): boolean { return [...this.#containers.values()].includes(processId); }

  #pendingStartForContainer(processId: string): Promise<{ processId: string; cdpBrowserEndpoint?: string }> | undefined {
    for (const [identity, pending] of this.#starting) {
      try {
        if (containerName(this.#options.containerPrefix, identity) === processId) return pending;
      } catch {
        // Identities are validated before they enter #starting. Keep stop idempotent if a future
        // naming policy rejects an already-pending identity.
      }
    }
    return undefined;
  }

  async #stopContainer(processId: string, fallbackTemporary?: { workerId: string; volumes: string[] }): Promise<void> {
    const guardian = this.#guardians.get(processId);
    this.#guardians.delete(processId);
    await guardian?.stop().catch(() => undefined);
    try {
      const stopped = await this.#command.run(["container", "stop", "--time", "10", processId], { timeoutMs: this.#options.stopTimeoutMs ?? 20_000 });
      if (stopped.exitCode !== 0 && !/no such container|is not running/i.test(stopped.stderr)) {
        throw new FabricError("worker_unavailable", `Docker could not stop browser container (${stopped.stderr.slice(0, 500)})`, 503);
      }
      const removed = await this.#command.run(["container", "rm", "--force", processId], { timeoutMs: this.#options.stopTimeoutMs ?? 20_000 });
      if (removed.exitCode !== 0 && !/no such container/i.test(removed.stderr)) {
        throw new FabricError("worker_unavailable", `Docker could not remove browser container (${removed.stderr.slice(0, 500)})`, 503);
      }
    } finally {
      for (const [identity, name] of this.#containers) if (name === processId) this.#containers.delete(identity);
      const temporary = this.#temporaryVolumesByContainer.get(processId) ?? fallbackTemporary;
      this.#temporaryVolumesByContainer.delete(processId);
      if (temporary) await this.#removeTemporaryVolumes(temporary.volumes);
    }
  }

  #runtimeNetworks(spec: BrowserProcessSpec): string[] {
    const networks = [...this.#options.browserNetworks];
    if (spec.container.networks.includes("fabric-egress") && this.#options.egressNetwork) networks.push(this.#options.egressNetwork);
    return [...new Set(networks)];
  }

  async #untrackedCleanupMetadata(name: string): Promise<{ workerId: string; volumes: string[] } | undefined> {
    const inspected = await this.#command.run([
      "container", "inspect", "--format", "{{ index .Config.Labels \"com.browser-fabric.worker-id\" }}|{{ index .Config.Labels \"com.browser-fabric.temporary-volumes\" }}", name,
    ], { timeoutMs: this.#options.stopTimeoutMs ?? 20_000 });
    if (inspected.exitCode !== 0) {
      if (/no such container/i.test(inspected.stderr)) return undefined;
      throw new FabricError("worker_unavailable", `Docker could not inspect prior browser container (${inspected.stderr.slice(0, 500)})`, 503);
    }
    const [workerId = "", rawVolumes = ""] = inspected.stdout.trim().split("|", 2);
    if (!safeWorkerId.test(workerId)) throw new FabricError("worker_unavailable", "prior browser container is missing a valid worker label", 503);
    const volumes = rawVolumes === "" || rawVolumes === "<no value>"
      ? []
      : rawVolumes.split(",").map((volume) => volume.trim()).filter(Boolean);
    if (volumes.some((volume) => !safeVolume.test(volume))) throw new FabricError("worker_unavailable", "prior browser container has an invalid temporary-volume label", 503);
    return { workerId, volumes: [...new Set(volumes)] };
  }

  #browserEndpoint(name: string, port: number): string {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("browser CDP port is invalid");
    return `http://${name}:${port}`;
  }

  async #waitForBrowserReady(browserEndpoint: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "no response";
    while (Date.now() < deadline) {
      try {
        const response = await this.#fetch(`${browserEndpoint}/json/version`, { signal: AbortSignal.timeout(Math.min(1_000, Math.max(100, deadline - Date.now()))) });
        if (response.ok) {
          const body = await response.json() as { webSocketDebuggerUrl?: unknown };
          if (typeof body.webSocketDebuggerUrl === "string" && body.webSocketDebuggerUrl.startsWith("ws://127.0.0.1:")) return;
          lastError = "browser returned no loopback websocket debugger URL";
        } else lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "browser readiness request failed";
      }
      await Bun.sleep(100);
    }
    throw new FabricError("worker_unavailable", `browser container ${browserEndpoint} did not become ready within ${timeoutMs}ms (${lastError})`, 503);
  }

  async #verifyEgressReady(spec: BrowserProcessSpec, timeoutMs: number): Promise<void> {
    const pacArgument = spec.container.command.find((argument) => argument.startsWith("--proxy-pac-url="));
    if (!pacArgument) throw new FabricError("validation_failed", "browser recipe does not declare a Fabric egress PAC", 400);
    let url: URL;
    try { url = new URL(pacArgument.slice("--proxy-pac-url=".length)); }
    catch { throw new FabricError("validation_failed", "browser egress PAC URL is invalid", 400); }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new FabricError("validation_failed", "browser egress PAC URL must be credential-free HTTP(S)", 400);
    }
    const deadline = Date.now() + timeoutMs;
    let lastError = "no response";
    while (Date.now() < deadline) {
      try {
        const response = await this.#fetch(url, { signal: AbortSignal.timeout(Math.min(1_000, Math.max(100, deadline - Date.now()))) });
        const body = response.ok ? await response.text() : "";
        if (response.ok) {
          try {
            assertFailClosedPac(body);
            return;
          } catch (error) {
            lastError = error instanceof Error ? error.message : "invalid egress PAC";
          }
        } else lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "egress PAC request failed";
      }
      await Bun.sleep(100);
    }
    throw new FabricError("worker_unavailable", `Fabric egress PAC did not become ready within ${timeoutMs}ms (${lastError})`, 503);
  }

  async #prepareVolumes(spec: BrowserProcessSpec, name: string, temporary: string[]): Promise<void> {
    const clone = spec.assignment.clone;
    const sourceProfile = spec.assignment.profile;
    if (clone) {
      if (!sourceProfile) throw new FabricError("validation_failed", "clone assignment is missing its source profile", 400);
      assertVolumeName(sourceProfile.volumeName);
      assertVolumeName(clone.volumeName);
      if (sourceProfile.volumeName === clone.volumeName) throw new FabricError("validation_failed", "clone volume must differ from its source profile volume", 400);
      temporary.push(clone.volumeName);
      await this.#prepareTemporaryVolume(clone.volumeName);
      await this.#copyVolume(sourceProfile.volumeName, clone.volumeName, name);
    }
    const ephemeral = spec.assignment.lease?.ephemeralVolumeName;
    if (ephemeral) {
      assertVolumeName(ephemeral);
      if (sourceProfile?.volumeName === ephemeral || clone?.volumeName === ephemeral) throw new FabricError("validation_failed", "ephemeral profile volume must be unique", 400);
      temporary.push(ephemeral);
      await this.#prepareTemporaryVolume(ephemeral);
    }
  }

  async #prepareTemporaryVolume(volume: string): Promise<void> {
    const created = await this.#command.run([
      "volume", "create",
      "--label", "com.browser-fabric.managed=true",
      "--label", "com.browser-fabric.temporary=true",
      volume,
    ], { timeoutMs: this.#options.startupTimeoutMs ?? 30_000 });
    if (created.exitCode !== 0) throw new FabricError("worker_unavailable", `Docker could not create temporary profile volume (${created.stderr.slice(0, 500)})`, 503);
    const owner = await this.#command.run(["volume", "inspect", "--format", "{{ index .Labels \"com.browser-fabric.managed\" }}|{{ index .Labels \"com.browser-fabric.temporary\" }}", volume], { timeoutMs: 10_000 });
    if (owner.exitCode !== 0 || owner.stdout.trim() !== "true|true") {
      throw new FabricError("worker_unavailable", "temporary profile volume is not owned by Browser Fabric", 503);
    }
    await this.#initializeVolumeOwnership(volume);
  }

  async #initializeVolumeOwnership(volume: string): Promise<void> {
    const helper = await this.#createVolumeHelper({
      kind: "profile-initialize",
      name: containerName("fabric-volume-init", `${volume}-${crypto.randomUUID().slice(0, 8)}`),
      mounts: [volumeMount(volume, "/volume")],
      command: ["/bin/sh", "-ceu", "mkdir -p /volume; chown -R 10001:10001 /volume"],
      allowChown: true,
    });
    await this.#runVolumeHelper(helper, this.#options.volumeCopyTimeoutMs ?? 60_000);
  }

  async #copyVolume(source: string, destination: string, name: string): Promise<void> {
    const helper = await this.#createVolumeHelper({
      kind: "profile-clone",
      name: containerName("fabric-volume-copy", `${name}-${crypto.randomUUID().slice(0, 8)}`),
      mounts: [
        volumeMount(source, "/source", true),
        volumeMount(destination, "/destination"),
      ],
      command: ["/bin/sh", "-ceu", "rm -rf /destination/* /destination/.[!.]* /destination/..?*; cp -a /source/. /destination/"],
      allowChown: true,
    });
    await this.#runVolumeHelper(helper, this.#options.volumeCopyTimeoutMs ?? 60_000);
  }

  async #clearVolume(volume: string): Promise<void> {
    const helper = await this.#createVolumeHelper({
      kind: "profile-cleanup",
      name: containerName("fabric-volume-clear", `${volume}-${crypto.randomUUID().slice(0, 8)}`),
      mounts: [volumeMount(volume, "/volume")],
      command: ["/bin/sh", "-ceu", "rm -rf /volume/* /volume/.[!.]* /volume/..?*"],
      allowChown: false,
    });
    await this.#runVolumeHelper(helper, this.#options.stopTimeoutMs ?? 20_000);
  }

  async #createVolumeHelper(input: { kind: string; name: string; mounts: readonly string[]; command: readonly string[]; allowChown?: boolean }): Promise<string> {
    const image = this.#options.volumeHelperImage ?? "busybox:1.36.1";
    assertImage(image, { requireImmutable: this.#options.requireImmutableImages, allowLocalBuildImages: this.#options.allowLocalBuildImages });
    const args = [
      "container", "create",
      "--name", input.name,
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      // Helpers are networkless and receive only explicitly validated Fabric
      // volumes. Copy/cleanup must still traverse profile files owned by the
      // unprivileged browser user, so restore only the three filesystem
      // capabilities needed for that bounded operation.
      ...(input.allowChown ? ["--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE"] : ["--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE"]),
      "--security-opt", "no-new-privileges:true",
      "--label", "com.browser-fabric.managed=true",
      "--label", `com.browser-fabric.kind=${input.kind}`,
    ];
    for (const mount of input.mounts) args.push("--mount", mount);
    args.push(image, ...input.command);
    const created = await this.#command.run(args, { timeoutMs: this.#options.startupTimeoutMs ?? 30_000 });
    if (created.exitCode !== 0) throw new FabricError("worker_unavailable", `Docker could not create profile-volume helper (${created.stderr.slice(0, 500)})`, 503);
    return input.name;
  }

  async #runVolumeHelper(name: string, timeoutMs: number): Promise<void> {
    try {
      const started = await this.#command.run(["container", "start", name], { timeoutMs: Math.min(timeoutMs, 30_000) });
      if (started.exitCode !== 0) throw new FabricError("worker_unavailable", `profile-volume helper could not start (${started.stderr.slice(0, 500)})`, 503);
      const deadline = Date.now() + timeoutMs;
      let last = "";
      while (Date.now() < deadline) {
        const inspected = await this.#command.run(["container", "inspect", "--format", "{{.State.Status}}|{{.State.ExitCode}}", name], { timeoutMs: 10_000 });
        last = `${inspected.stdout}\n${inspected.stderr}`.trim();
        const [status, exitCode] = inspected.stdout.trim().split("|", 2);
        if (status === "exited" && exitCode === "0") return;
        if (["exited", "dead"].includes(status ?? "")) throw new FabricError("worker_unavailable", `profile-volume helper failed (${last.slice(0, 500)})`, 503);
        await Bun.sleep(100);
      }
      throw new FabricError("worker_unavailable", `profile-volume helper timed out (${last.slice(0, 500)})`, 503);
    } finally {
      await this.#command.run(["container", "rm", "--force", name], { timeoutMs: this.#options.stopTimeoutMs ?? 20_000 }).catch(() => undefined);
    }
  }

  async #removeTemporaryVolumes(volumes: readonly string[]): Promise<void> {
    for (const volume of [...new Set(volumes)]) {
      assertVolumeName(volume);
      await this.#clearVolume(volume).catch(() => undefined);
      const removed = await this.#command.run(["volume", "rm", volume], { timeoutMs: this.#options.stopTimeoutMs ?? 20_000 }).catch(() => undefined);
      if (removed && removed.exitCode !== 0 && !/no such volume/i.test(removed.stderr)) {
        throw new FabricError("worker_unavailable", `Docker could not remove temporary profile volume (${removed.stderr.slice(0, 500)})`, 503);
      }
    }
  }
}

/** Docker-container implementation for bounded one-shot media relay work. */
export class DockerMediaContainerExecutor implements MediaExecutor {
  readonly #command: DockerCommand;
  readonly #containerExecutor: DockerContainerExecutor;
  readonly #waitTimeoutMs: number;

  public constructor(options: DockerContainerExecutorOptions = {}) {
    this.#command = options.command ?? new ChildProcessDockerCommand();
    this.#waitTimeoutMs = Math.max(1_000, Math.min(15 * 60_000, options.startupTimeoutMs ?? 60_000));
    this.#containerExecutor = new DockerContainerExecutor({ ...options, command: this.#command, containerPrefix: options.containerPrefix ?? "fabric-media" });
  }

  public async start(input: Parameters<MediaExecutor["start"]>[0]): Promise<{ processId: string }> {
    if (!input.assignment.job || input.assignment.lease) throw new FabricError("validation_failed", "invalid media assignment", 400);
    const serializedSource = JSON.stringify(input.relay.source);
    if (new TextEncoder().encode(serializedSource).byteLength > MEDIA_SOURCE_MAX_BYTES) throw new FabricError("validation_failed", "media manifest exceeds the worker environment limit", 400);
    let resultEndpoint: URL;
    try { resultEndpoint = new URL(input.relay.resultEndpoint); }
    catch { throw new FabricError("validation_failed", "media result endpoint is invalid", 400); }
    if ((resultEndpoint.protocol !== "http:" && resultEndpoint.protocol !== "https:") || !resultEndpoint.hostname || resultEndpoint.username || resultEndpoint.password || resultEndpoint.search || resultEndpoint.hash) {
      throw new FabricError("validation_failed", "media result endpoint must be a credential-free HTTP(S) URL", 400);
    }
    if (!/^[A-Za-z0-9_.-]{32,8192}$/.test(input.relay.resultCapability)) throw new FabricError("validation_failed", "media result capability is invalid", 400);
    const container = {
      workerId: input.worker.id,
      jobId: input.assignment.job.id,
      image: input.assignment.recipe.browserImage,
      browserVersion: "none",
      command: ["/usr/local/bin/fabric-media-relay"],
      environment: {
        FABRIC_WORKER_ID: input.worker.id,
        FABRIC_JOB_ID: input.assignment.job.id,
        FABRIC_EGRESS_POLICY_REF: input.egressPolicy.ref,
        FABRIC_EGRESS_PROXY_URL: internalEgressProxyUrl(input.egressPolicy, { host: process.env.FABRIC_EGRESS_PROXY_HOST?.trim() || "fabric-egress-sidecar", trafficClass: "media_range" }),
        ...(input.egressPolicy.directExceptionHostnames?.length
          ? {
              FABRIC_EGRESS_DIRECT_PROXY_URL: internalEgressProxyUrl(input.egressPolicy, { host: process.env.FABRIC_EGRESS_PROXY_HOST?.trim() || "fabric-egress-sidecar", trafficClass: "direct_exception" }),
              FABRIC_MEDIA_DIRECT_EXCEPTION_SUFFIXES: JSON.stringify(input.egressPolicy.directExceptionHostnames),
            }
          : {}),
        FABRIC_MEDIA_SOURCE_JSON: serializedSource,
        FABRIC_MEDIA_RESULT_URL: resultEndpoint.toString(),
        FABRIC_MEDIA_RESULT_CAPABILITY: input.relay.resultCapability,
      },
      volumes: [],
      networks: ["fabric-workers", "fabric-egress"],
      limits: input.worker.resourceLimits,
      security: { dockerSocketMounted: false, hostHomeMounted: false, repositoryMounted: false, applicationSecretsMounted: false } as const,
      cdpBind: { host: "private-overlay" as const, port: 0 },
    };
    const result = await this.#containerExecutor.start({ assignment: input.assignment, container, egress: {} as never, resourceLimits: input.worker.resourceLimits, security: container.security });
    return { processId: result.processId };
  }

  public stop(processId: string): Promise<void> { return this.#containerExecutor.stop(processId); }
  public isRunning(processId: string): Promise<boolean> { return this.#containerExecutor.isRunning(processId); }

  /** Stop inherited one-shot containers before their durable jobs are requeued after a manager restart. */
  public async stopUntrackedMediaContainers(): Promise<readonly { containerName: string; workerId: string; jobId: string }[]> {
    const listed = await this.#command.run([
      "container", "ls", "--all", "--filter", "label=com.browser-fabric.kind=media", "--format", "{{.Names}}",
    ], { timeoutMs: 20_000 });
    if (listed.exitCode !== 0) throw new FabricError("worker_unavailable", `Docker could not list prior media containers (${listed.stderr.slice(0, 500)})`, 503);
    const records: { containerName: string; workerId: string; jobId: string }[] = [];
    for (const name of [...new Set(listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))]) {
      if (!safeContainerName.test(name)) throw new FabricError("worker_unavailable", "Docker returned an invalid managed media container name", 503);
      const inspected = await this.#command.run([
        "container", "inspect", "--format", "{{ index .Config.Labels \"com.browser-fabric.worker-id\" }}|{{ index .Config.Labels \"com.browser-fabric.job-id\" }}", name,
      ], { timeoutMs: 20_000 });
      if (inspected.exitCode !== 0) {
        if (/no such container/i.test(inspected.stderr)) continue;
        throw new FabricError("worker_unavailable", `Docker could not inspect prior media container (${inspected.stderr.slice(0, 500)})`, 503);
      }
      const [workerId = "", jobId = ""] = inspected.stdout.trim().split("|", 2);
      if (!safeWorkerId.test(workerId) || !/^job_[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(jobId)) {
        throw new FabricError("worker_unavailable", "prior media container has invalid Fabric identity labels", 503);
      }
      await this.#containerExecutor.removeUntrackedContainer(name);
      records.push({ containerName: name, workerId, jobId });
    }
    return records;
  }

  /** Wait for the one-shot relay and parse only its bounded structured completion line. */
  public async wait(processId: string, timeoutMs = this.#waitTimeoutMs): Promise<{ status: "succeeded" | "failed"; result?: Record<string, unknown>; reason?: string }> {
    const deadline = Date.now() + Math.max(1_000, Math.min(15 * 60_000, timeoutMs));
    while (Date.now() < deadline) {
      const inspected = await this.#command.run(["container", "inspect", "--format", "{{.State.Status}}|{{.State.ExitCode}}", processId], { timeoutMs: 10_000 });
      if (inspected.exitCode !== 0) return { status: "failed", reason: "media relay container disappeared" };
      const [state, exitCode] = inspected.stdout.trim().split("|", 2);
      if (["exited", "dead"].includes(state ?? "")) {
        if (exitCode !== "0") return { status: "failed", reason: "media relay container failed" };
        const logs = await this.#command.run(["container", "logs", processId], { timeoutMs: 10_000 }).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
        const lines = `${logs.stdout}\n${logs.stderr}`.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (parsed.status === "succeeded" && typeof parsed.receipt === "string" && /^[A-Za-z0-9_-]{16,8192}\.[A-Za-z0-9_-]{16,128}$/.test(parsed.receipt)) {
              return { status: "succeeded", result: { receipt: parsed.receipt } };
            }
            if (parsed.status === "failed") return { status: "failed", reason: "media relay reported failure" };
          } catch {
            // Docker diagnostics and upstream output are untrusted. Ignore non-protocol lines.
          }
        }
        return { status: "failed", reason: "media relay completed without a valid result" };
      }
      await Bun.sleep(250);
    }
    return { status: "failed", reason: "media relay timed out" };
  }
}
