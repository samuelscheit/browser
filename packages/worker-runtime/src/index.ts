import { createHash } from "node:crypto";
import { NativeSocialRuntime } from "./social";
import type { BrowserRecipe, EgressPolicy, Worker, WorkerAssignment } from "@browser-fabric/contracts";
import { FabricError } from "@browser-fabric/contracts";

export interface ContainerSecurity {
  dockerSocketMounted: false;
  hostHomeMounted: false;
  repositoryMounted: false;
  applicationSecretsMounted: false;
}

export interface BrowserContainerSpec {
  workerId: Worker["id"];
  leaseId?: string;
  jobId?: string;
  sessionId?: string;
  image: string;
  browserVersion: string;
  command: readonly string[];
  environment: Readonly<Record<string, string>>;
  volumes: readonly { source: string; target: string; readOnly: boolean }[];
  networks: readonly string[];
  limits: Worker["resourceLimits"];
  security: ContainerSecurity;
  cdpBind: { host: "127.0.0.1" | "private-overlay"; port: number };
}

export interface BrowserRuntime {
  readonly family: string;
  buildSpec(assignment: WorkerAssignment, worker: Worker, policy: EgressPolicy): BrowserContainerSpec;
}

const forbiddenEnv = /(PASSWORD|SECRET|TOKEN|COOKIE|CREDENTIAL|AUTHORIZATION|OTP|MS_TOKEN)/i;

function assertNoSecretEnvironment(environment: Record<string, string>): void {
  for (const key of Object.keys(environment)) {
    if (forbiddenEnv.test(key)) throw new FabricError("secret_rejected", `runtime environment key ${key} is not allowed; request input ephemerally`, 400);
  }
}

function runtimeNetworks(policy: EgressPolicy): string[] {
  // Workers can reach only control, worker, and the policy-selected egress sidecar.
  const networks = ["fabric-control", "fabric-workers"];
  if (Object.values(policy.routes).some((route) => route?.kind === "proxy" || route?.kind === "tor")) networks.push("fabric-egress");
  return networks;
}

export class GenericBrowserRuntime implements BrowserRuntime {
  public constructor(readonly family: string) {}

  public buildSpec(assignment: WorkerAssignment, worker: Worker, policy: EgressPolicy): BrowserContainerSpec {
    const recipe: BrowserRecipe = assignment.recipe;
    const lease = assignment.lease;
    const session = assignment.session;
    const job = assignment.job;
    if (recipe.runtime !== this.family) throw new FabricError("validation_failed", `runtime ${this.family} cannot execute ${recipe.runtime}`, 400);
    if (recipe.mode === "interactive" && !worker.isLocal) throw new FabricError("worker_unavailable", "interactive recipes require the federated local worker", 409);
    if (lease && lease.workerId !== worker.id) throw new FabricError("authorization_denied", "assignment worker mismatch", 403);
    const profileVolume = assignment.clone?.volumeName ?? assignment.profile?.volumeName ?? assignment.lease?.ephemeralVolumeName;
    const volumes = profileVolume ? [{ source: profileVolume, target: "/fabric/profile", readOnly: false }] : [];
    if (!profileVolume && recipe.mode !== "headless") throw new FabricError("validation_failed", "interactive/headful browser requires a profile volume", 400);
    const cdpPort = 9222;
    const environment: Record<string, string> = {
      FABRIC_WORKER_ID: worker.id,
      FABRIC_RUNTIME: recipe.runtime,
      FABRIC_RECIPE_REF: recipe.ref,
      FABRIC_EGRESS_POLICY_REF: policy.ref,
      FABRIC_CDP_PORT: String(cdpPort),
      ...(session ? { FABRIC_SESSION_ID: session.id } : {}),
      ...(job ? { FABRIC_JOB_ID: job.id } : {})
    };
    assertNoSecretEnvironment(environment);
    return {
      workerId: worker.id,
      ...(lease ? { leaseId: lease.id } : {}),
      ...(job ? { jobId: job.id } : {}),
      ...(session ? { sessionId: session.id } : {}),
      image: recipe.browserImage,
      browserVersion: recipe.browserVersion,
      command: [
        "/usr/bin/chromium",
        // Managed browser containers bind only to the private overlay; the local federated
        // worker keeps loopback binding because its supervisor connects locally.
        `--remote-debugging-address=${worker.isLocal ? "127.0.0.1" : "0.0.0.0"}`,
        `--remote-debugging-port=${cdpPort}`,
        ...(recipe.mode === "headless" ? ["--headless=new"] : []),
        ...(recipe.mode === "interactive" ? ["--start-maximized"] : []),
        ...(recipe.launch.disableServiceWorkers ? ["--disable-service-worker"] : []),
        ...recipe.launch.launchFlags
      ],
      environment,
      volumes,
      networks: runtimeNetworks(policy),
      limits: worker.resourceLimits,
      security: { dockerSocketMounted: false, hostHomeMounted: false, repositoryMounted: false, applicationSecretsMounted: false },
      cdpBind: { host: worker.isLocal ? "127.0.0.1" : "private-overlay", port: cdpPort }
    };
  }
}

/** Media relay workers execute HTTP range work without starting Chromium or consuming a lease. */
export class MediaRelayRuntime implements BrowserRuntime {
  readonly family = "media-relay";
  public buildSpec(assignment: WorkerAssignment, worker: Worker, policy: EgressPolicy): BrowserContainerSpec {
    if (assignment.lease) throw new FabricError("validation_failed", "media relay assignments must not carry a browser lease", 400);
    if (!assignment.job || assignment.job.runtime !== "media-relay" || assignment.job.workerId !== worker.id) throw new FabricError("authorization_denied", "invalid media relay assignment", 403);
    if (!policy.constraints.allowDirectMediaRelay) throw new FabricError("validation_failed", "media relay is disabled by egress policy", 400);
    return {
      workerId: worker.id,
      jobId: assignment.job.id,
      image: "ghcr.io/browser-fabric/media-relay:1",
      browserVersion: "none",
      command: ["/usr/local/bin/fabric-media-relay"],
      environment: { FABRIC_WORKER_ID: worker.id, FABRIC_JOB_ID: assignment.job.id, FABRIC_EGRESS_POLICY_REF: policy.ref },
      volumes: [],
      networks: ["fabric-control", "fabric-workers", "fabric-egress"],
      limits: worker.resourceLimits,
      security: { dockerSocketMounted: false, hostHomeMounted: false, repositoryMounted: false, applicationSecretsMounted: false },
      cdpBind: { host: "private-overlay", port: 0 }
    };
  }
}

export class WorkerRuntimeRegistry {
  readonly #runtimes = new Map<string, BrowserRuntime>();

  public register(runtime: BrowserRuntime): void {
    if (this.#runtimes.has(runtime.family)) throw new Error(`runtime ${runtime.family} is already registered`);
    this.#runtimes.set(runtime.family, runtime);
  }

  public get(family: string): BrowserRuntime {
    const runtime = this.#runtimes.get(family);
    if (!runtime) throw new FabricError("not_found", `worker runtime ${family} is not registered`, 404);
    return runtime;
  }

  public list(): readonly string[] {
    return [...this.#runtimes.keys()].sort();
  }
}

export function defaultRuntimeRegistry(): WorkerRuntimeRegistry {
  const registry = new WorkerRuntimeRegistry();
  for (const family of ["chromium-cdp", "patchright", "rebrowser-puppeteer", "companion"]) registry.register(new GenericBrowserRuntime(family));
  registry.register(new NativeSocialRuntime());
  registry.register(new MediaRelayRuntime());
  return registry;
}

export function artifactChecksum(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
export * from "./chromium";
export * from "./social";
