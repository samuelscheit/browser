import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { FabricError, type ChallengeHandler } from "@browser-fabric/contracts";
import { assertFailClosedPac } from "@browser-fabric/policy";
import {
  assertTurnstileGuardianSpec,
  closeBrowserGracefully,
  defaultTurnstileGuardianFactory,
  type TokenCaptchaSolver,
  type TurnstileGuardianFactory,
  type TurnstileGuardianHandle,
} from "@browser-fabric/worker-runtime";
import type { BrowserProcessSpec, Executor } from "./index";

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
  /**
   * The Fabric deployment this manager belongs to (its Compose project name). Every container
   * and volume it creates carries it, and restart recovery reaps only its own, so stacks sharing
   * a Docker host (an old and a new one side by side) never touch each other's browsers.
   */
  deploymentId?: string;
  /** Fetch implementation used from the manager network to prove browser readiness. */
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Controller-owned runtime images. Recipe image metadata never chooses an image at runtime. */
  runtimeImageOverrides?: Readonly<Record<string, string>>;
  /** Reject any launch whose runtime has no controller-owned override. */
  requireRuntimeImageOverrides?: boolean;
  /** Permit immutable registry images only unless a locally built Fabric tag is explicitly allowed. */
  requireImmutableImages?: boolean;
  /** Accept `browser-fabric-*:local` images that the deployment builds from this source tree. */
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
  /**
   * Path of the narrowly reviewed Chromium user-namespace seccomp profile
   * (CHROMIUM_SECCOMP_PROFILE_PATH). The Docker CLI in the manager container
   * reads it and sends the profile content to the daemon.
   */
  browserSeccompProfile?: string;
  /** Fail browser starts closed when a production seccomp profile is absent. */
  requireBrowserSeccompProfile?: boolean;
  /** Factory boundary for the mandatory browser-level companion; production uses real CDP. */
  turnstileGuardianFactory?: TurnstileGuardianFactory;
  /** Orderly browser shutdown before Docker stops the container. Tests inject a fake. */
  closeBrowser?: typeof closeBrowserGracefully;
  /**
   * Resolves the token solver for one browser from its recipe's challenge handler set. Absent in tests and
   * in deployments without solver credentials; a recipe then never solves tokens.
   */
  tokenSolverFor?: (handlers: readonly ChallengeHandler[] | undefined) => TokenCaptchaSolver | undefined;
}

/** Label naming the deployment that owns a Docker container or volume. */
export const DEPLOYMENT_LABEL = "com.browser-fabric.deployment";
/** A Compose project name: lowercase letters, digits, dashes and underscores. */
const safeDeploymentId = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const safeContainerName = /^[a-z][a-z0-9_-]{0,62}$/;
const safeVolume = /^[a-z][a-z0-9_.-]{0,127}$/;
const safeWorkerId = /^worker_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const safeAssignmentId = /^(?:browser-lease|job)_[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const safeNetworkName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const localFabricImage = /^browser-fabric-[a-z][a-z0-9-]{0,62}:local$/;
const immutableImage = /^.+@sha256:[a-f0-9]{64}$/i;
const forbiddenEnv = /(PASSWORD|SECRET|TOKEN|COOKIE|CREDENTIAL|AUTHORIZATION|OTP|MS_TOKEN)/i;
const forbiddenArg = /(^|\s)(--no-sandbox|--disable-web-security)(\s|$)/;
/** Unprivileged uid:gid every Fabric browser image runs as; profile volumes must be owned by it. */
const browserVolumeOwner = "10001:10001";
/**
 * The one approved path of the Chromium user-namespace seccomp profile inside the manager container
 * (deploy/compose bind-mounts deploy/compose/chromium-userns-seccomp.json there). The Docker client
 * reads the file and sends its content with each container create request.
 */
export const CHROMIUM_SECCOMP_PROFILE_PATH = "/etc/browser-fabric/chromium-userns-seccomp.json";

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
    throw new FabricError("validation_failed", "production browser image must be an immutable digest or a local browser-fabric-*:local build", 400);
  }
}

function assertVolumeName(name: string): void {
  if (!safeVolume.test(name)) throw new FabricError("validation_failed", "Docker volume name is invalid", 400);
}

function assertNetworkName(name: string): void {
  if (!safeNetworkName.test(name)) throw new FabricError("validation_failed", "Docker network name is invalid", 400);
}

function assertBrowserSeccompProfile(value: string | undefined, required: boolean): void {
  if (!value) {
    if (required) throw new FabricError("worker_unavailable", "managed browser seccomp profile is required", 503);
    return;
  }
  if (value !== CHROMIUM_SECCOMP_PROFILE_PATH) {
    throw new FabricError("validation_failed", "managed browser seccomp profile path is not approved", 400);
  }
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
  if (spec.container.cdpBind.host !== "private-overlay" || spec.container.cdpBind.port < 1024 || spec.container.cdpBind.port > 65_535) {
    throw new FabricError("validation_failed", "browser CDP must bind to a private worker network port", 400);
  }
  if (!spec.container.turnstileGuardian) throw new FabricError("validation_failed", "every Fabric browser must declare the Turnstile guardian", 400);
  try { assertTurnstileGuardianSpec(spec.container.turnstileGuardian); }
  catch (error) { throw new FabricError("validation_failed", error instanceof Error ? error.message : "invalid Turnstile guardian", 400); }
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

function createArgs(spec: BrowserProcessSpec, name: string, deploymentId: string, primaryNetwork: string, temporaryVolumes: readonly string[], browserSeccompProfile?: string): string[] {
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
    "--label", `${DEPLOYMENT_LABEL}=${deploymentId}`,
    "--label", "com.browser-fabric.kind=browser",
    "--label", `com.browser-fabric.worker-id=${container.workerId}`,
    ...(temporary === undefined ? [] : ["--label", `com.browser-fabric.temporary-volumes=${temporary}`]),
    ...(container.leaseId ? ["--label", `com.browser-fabric.lease-id=${container.leaseId}`] : []),
    ...(container.jobId ? ["--label", `com.browser-fabric.job-id=${container.jobId}`] : []),
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    ...(browserSeccompProfile ? ["--security-opt", `seccomp=${browserSeccompProfile}`] : []),
    "--cpus", String(Math.max(0.1, container.limits.cpuMilli / 1_000)),
    "--memory", `${container.limits.memoryMiB}m`,
    "--pids-limit", String(container.limits.pids),
    // Chromium's private X server needs a user-writable sticky temp root and
    // Unix-domain socket directory. No executable temp files or host paths are
    // permitted.
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=1073741824,mode=1777",
    "--tmpfs", "/tmp/.X11-unix:rw,nosuid,nodev,size=1048576,mode=1777",
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
  readonly #options: Required<Pick<DockerContainerExecutorOptions, "browserNetworks" | "containerPrefix" | "deploymentId">> & Omit<DockerContainerExecutorOptions, "browserNetworks" | "containerPrefix" | "deploymentId">;
  readonly #containers = new Map<string, string>();
  readonly #starting = new Map<string, Promise<{ processId: string; cdpBrowserEndpoint?: string }>>();
  readonly #guardians = new Map<string, TurnstileGuardianHandle>();
  readonly #browserEndpoints = new Map<string, string>();
  readonly #closeBrowser: typeof closeBrowserGracefully;
  readonly #temporaryVolumesByContainer = new Map<string, { workerId: string; volumes: string[] }>();
  readonly #turnstileGuardianFactory: TurnstileGuardianFactory;

  public constructor(options: DockerContainerExecutorOptions = {}) {
    this.#command = options.command ?? new ChildProcessDockerCommand();
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#turnstileGuardianFactory = options.turnstileGuardianFactory ?? defaultTurnstileGuardianFactory;
    this.#closeBrowser = options.closeBrowser ?? closeBrowserGracefully;
    this.#options = {
      browserNetworks: options.browserNetworks ?? ["browser-fabric-workers"],
      containerPrefix: options.containerPrefix ?? "fabric-browser",
      requireImmutableImages: options.requireImmutableImages ?? process.env.NODE_ENV === "production",
      requireRuntimeImageOverrides: options.requireRuntimeImageOverrides ?? process.env.NODE_ENV === "production",
      ...options,
      deploymentId: options.deploymentId ?? "browser-fabric",
    };
    if (!safeDeploymentId.test(this.#options.deploymentId)) throw new Error("deploymentId must be a Compose project name (lowercase letters, digits, - and _)");
    for (const network of this.#options.browserNetworks) assertNetworkName(network);
    if (this.#options.egressNetwork) assertNetworkName(this.#options.egressNetwork);
    assertBrowserSeccompProfile(this.#options.browserSeccompProfile, this.#options.requireBrowserSeccompProfile === true);
  }

  public async start(spec: BrowserProcessSpec): Promise<{ processId: string; cdpBrowserEndpoint?: string }> {
    const runtime = spec.assignment.recipe.runtime;
    const override = this.#options.runtimeImageOverrides?.[runtime];
    if (this.#options.requireRuntimeImageOverrides && !override) {
      throw new FabricError("worker_unavailable", `no controller-owned Docker image is configured for runtime ${runtime}`, 503);
    }
    const effectiveSpec = override ? { ...spec, container: { ...spec.container, image: override } } : spec;
    assertSpec(effectiveSpec, new Set(this.#options.allowedEnvironmentKeys ?? []));
    assertBrowserSeccompProfile(this.#options.browserSeccompProfile, this.#options.requireBrowserSeccompProfile === true);
    assertImage(effectiveSpec.container.image, {
      requireImmutable: this.#options.requireImmutableImages,
      allowLocalBuildImages: this.#options.allowLocalBuildImages,
    });
    if (this.#options.verifyEgressReady) {
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
    let browserEndpoint: string | undefined;
    try {
      await this.#prepareVolumes(spec, name, temporaryVolumes);
      const primaryNetwork = this.#options.browserNetworks[0];
      if (!primaryNetwork) throw new FabricError("worker_unavailable", "no Fabric worker network is configured", 503);
      const createdContainer = await this.#command.run(createArgs(spec, name, this.#options.deploymentId, primaryNetwork, temporaryVolumes, this.#options.browserSeccompProfile), { timeoutMs: this.#options.startupTimeoutMs ?? 30_000 });
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

      // The manager itself is also on the egress network, so Docker's
      // container-name DNS can resolve a dynamic browser to its egress IP.
      // Resolve the exact address assigned on the fixed worker network
      // instead. The browser bridge is deliberately bound to this address;
      // the CDP gateway retains the worker-owned hostname route separately.
      browserEndpoint = await this.#browserEndpointOnNetwork(name, spec.container.cdpBind.port, primaryNetwork);
      await this.#waitForBrowserReady(browserEndpoint, this.#options.browserReadyTimeoutMs ?? this.#options.startupTimeoutMs ?? 30_000);
      if (this.#containers.get(identity) !== name) throw new FabricError("worker_unavailable", "browser container was stopped while becoming ready", 503);
      const guardianSpec = spec.container.turnstileGuardian;
      if (!guardianSpec) throw new Error("Fabric browser has no Turnstile guardian specification");
      // The recipe's challenge handler set decides whether this browser may solve tokens. Credentials
      // come only from the manager's secret-backed solver factory, never from a browser environment.
      const tokenSolver = this.#options.tokenSolverFor?.(spec.container.challengeHandlers);
      const guardian = this.#turnstileGuardianFactory({ endpoint: browserEndpoint, spec: guardianSpec, ...(tokenSolver ? { tokenSolver } : {}) });
      this.#guardians.set(name, guardian);
      this.#browserEndpoints.set(name, browserEndpoint);
      await guardian.start();
      if (this.#containers.get(identity) !== name || this.#guardians.get(name) !== guardian) {
        await guardian.stop().catch(() => undefined);
        throw new FabricError("worker_unavailable", "browser container was stopped while its Turnstile guardian was starting", 503);
      }
      if (!guardian.snapshot.running) throw new FabricError("worker_unavailable", "Turnstile guardian did not become ready", 503);
    } catch (error) {
      if (created) await this.#stopContainer(name, { workerId: spec.container.workerId, volumes: temporaryVolumes }).catch(() => undefined);
      else await this.#removeTemporaryVolumes(temporaryVolumes).catch(() => undefined);
      throw error;
    }
    return {
      processId: name,
      ...(browserEndpoint === undefined ? {} : { cdpBrowserEndpoint: browserEndpoint }),
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
   * A manager restart loses its in-memory guardian handles. Stop every lease
   * browser container of this deployment before reclaiming durable assignments
   * so a stale browser can never outlive guardian ownership. Containers of other
   * deployments on the same Docker host are left alone (Docker ANDs the filters).
   */
  public async stopUntrackedBrowserContainers(): Promise<readonly string[]> {
    const listed = await this.#command.run([
      "container", "ls", "--all",
      "--filter", `label=${DEPLOYMENT_LABEL}=${this.#options.deploymentId}`,
      "--filter", "label=com.browser-fabric.lease-id",
      "--format", "{{.Names}}",
    ], { timeoutMs: this.#options.stopTimeoutMs ?? 20_000 });
    if (listed.exitCode !== 0) throw new FabricError("worker_unavailable", `Docker could not list prior browser containers (${listed.stderr.slice(0, 500)})`, 503);
    const stopped: string[] = [];
    for (const name of new Set(listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))) {
      if (!safeContainerName.test(name)) throw new FabricError("worker_unavailable", "Docker returned an invalid managed browser container name", 503);
      const metadata = await this.#untrackedCleanupMetadata(name);
      // The label filter already selected this deployment; re-checked on the inspected container.
      if (metadata && metadata.deploymentId !== this.#options.deploymentId) continue;
      await this.#stopContainer(name, metadata);
      stopped.push(name);
    }
    return stopped;
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
    const browserEndpoint = this.#browserEndpoints.get(processId);
    this.#browserEndpoints.delete(processId);
    // Let Chromium write its profile (cookies especially) before Docker signals the container.
    if (browserEndpoint) await this.#closeBrowser(browserEndpoint, { timeoutMs: 8_000 }).catch(() => false);
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

  async #untrackedCleanupMetadata(name: string): Promise<{ deploymentId: string; workerId: string; volumes: string[] } | undefined> {
    const inspected = await this.#command.run([
      "container", "inspect", "--format", `{{ index .Config.Labels "${DEPLOYMENT_LABEL}" }}|{{ index .Config.Labels "com.browser-fabric.worker-id" }}|{{ index .Config.Labels "com.browser-fabric.temporary-volumes" }}`, name,
    ], { timeoutMs: this.#options.stopTimeoutMs ?? 20_000 });
    if (inspected.exitCode !== 0) {
      if (/no such container/i.test(inspected.stderr)) return undefined;
      throw new FabricError("worker_unavailable", `Docker could not inspect prior browser container (${inspected.stderr.slice(0, 500)})`, 503);
    }
    const [deploymentId = "", workerId = "", rawVolumes = ""] = inspected.stdout.trim().split("|", 3);
    if (!safeWorkerId.test(workerId)) throw new FabricError("worker_unavailable", "prior browser container is missing a valid worker label", 503);
    const volumes = rawVolumes === "" || rawVolumes === "<no value>"
      ? []
      : rawVolumes.split(",").map((volume) => volume.trim()).filter(Boolean);
    if (volumes.some((volume) => !safeVolume.test(volume))) throw new FabricError("worker_unavailable", "prior browser container has an invalid temporary-volume label", 503);
    return { deploymentId, workerId, volumes: [...new Set(volumes)] };
  }

  async #browserEndpointOnNetwork(name: string, port: number, network: string): Promise<string> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("browser CDP port is invalid");
    assertNetworkName(network);
    const inspected = await this.#command.run([
      "container", "inspect", "--format", "{{json .NetworkSettings.Networks}}", name,
    ], { timeoutMs: this.#options.startupTimeoutMs ?? 30_000 });
    if (inspected.exitCode !== 0) throw new FabricError("worker_unavailable", `Docker could not inspect the browser worker-network address (${inspected.stderr.slice(0, 500)})`, 503);
    let networks: Record<string, { IPAddress?: unknown }>;
    try {
      const parsed = JSON.parse(inspected.stdout.trim()) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid Docker network state");
      networks = parsed as Record<string, { IPAddress?: unknown }>;
    } catch {
      throw new FabricError("worker_unavailable", "Docker returned invalid browser network state", 503);
    }
    const address = networks[network]?.IPAddress;
    if (typeof address !== "string" || isIP(address) !== 4 || address === "0.0.0.0" || address.startsWith("127.")) {
      throw new FabricError("worker_unavailable", "browser has no valid private worker-network address", 503);
    }
    return `http://${address}:${port}`;
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
      "--label", `${DEPLOYMENT_LABEL}=${this.#options.deploymentId}`,
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
      command: ["/bin/sh", "-ceu", `mkdir -p /volume; chown -R ${browserVolumeOwner} /volume`],
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
      // `cp -a` preserves the source's ownership (and overwrites the directory's), so a
      // root-owned source profile would leave the unprivileged browser unable to write
      // its clone. Re-own the copy so clones work however the source volume was created.
      command: ["/bin/sh", "-ceu", `rm -rf /destination/* /destination/.[!.]* /destination/..?*; cp -a /source/. /destination/; chown -R ${browserVolumeOwner} /destination`],
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
      "--label", `${DEPLOYMENT_LABEL}=${this.#options.deploymentId}`,
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
