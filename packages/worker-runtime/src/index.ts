import { createHash } from "node:crypto";
import { turnstileGuardianSpecFromEnvironment, type TurnstileGuardianSpec } from "./turnstile-guardian";
import type { BrowserRecipe, ChallengeHandler, EgressPolicy, Worker, WorkerAssignment } from "@browser-fabric/contracts";
import { FabricError } from "@browser-fabric/contracts";
import { internalEgressPacUrl } from "@browser-fabric/policy";

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
  /**
   * A browser-level, Fabric-owned companion that observes Cloudflare
   * Turnstile widgets and performs one bounded, trusted checkbox click.
   * It is deliberately part of the worker spec, not an opt-in application
   * client feature, so all ordinary CDP browser sessions receive it.
   */
  turnstileGuardian?: TurnstileGuardianSpec;
  /**
   * The recipe's automatic challenge handlers, copied from the signed assignment. Executors use them to
   * decide which token solvers this browser may use. Absent when the recipe declares no challenge set.
   */
  challengeHandlers?: readonly ChallengeHandler[];
}

export interface BrowserRuntime {
  readonly family: string;
  buildSpec(assignment: WorkerAssignment, worker: Worker, policy: EgressPolicy): BrowserContainerSpec;
}

const forbiddenEnv = /(PASSWORD|SECRET|TOKEN|COOKIE|CREDENTIAL|AUTHORIZATION|OTP|MS_TOKEN)/i;
const forbiddenRecipeLaunchFlag = /^(--(?:no-proxy-server|proxy-(?:server|pac-url|bypass-list|auto-detect)|host-resolver-rules|remote-debugging-(?:address|port)|user-data-dir)(?:=|$)|--disable-quic(?:=|$)|--force-webrtc-ip-handling-policy(?:=|$))/i;

function assertNoSecretEnvironment(environment: Record<string, string>): void {
  for (const key of Object.keys(environment)) {
    if (forbiddenEnv.test(key)) throw new FabricError("secret_rejected", `runtime environment key ${key} is not allowed; request input ephemerally`, 400);
  }
}

function runtimeNetworks(policy: EgressPolicy): string[] {
  // Ephemeral browser processes can speak CDP to the gateway on the worker overlay, but must not
  // share the control overlay with API, scheduler, or input-broker services. Every browser joins
  // the internal egress overlay, including `direct-egress`: direct traffic is still forwarded by
  // the policy sidecar and therefore cannot escape through a second Docker network.
  void policy;
  return ["fabric-workers", "fabric-egress"];
}

function assertRecipeEgressFlags(recipe: BrowserRecipe): void {
  for (const flag of recipe.launch.launchFlags) {
    if (forbiddenRecipeLaunchFlag.test(flag)) {
      throw new FabricError("validation_failed", `recipe ${recipe.ref} may not override Fabric egress enforcement`, 400);
    }
  }
}

export class GenericBrowserRuntime implements BrowserRuntime {
  public constructor(readonly family: string) {}

  public buildSpec(assignment: WorkerAssignment, worker: Worker, policy: EgressPolicy): BrowserContainerSpec {
    const recipe: BrowserRecipe = assignment.recipe;
    const lease = assignment.lease;
    const session = assignment.session;
    const job = assignment.job;
    if (recipe.runtime !== this.family) throw new FabricError("validation_failed", `runtime ${this.family} cannot execute ${recipe.runtime}`, 400);
    assertRecipeEgressFlags(recipe);
    if (recipe.mode === "interactive" && !worker.capabilities.supportsInteractive) {
      throw new FabricError("worker_unavailable", "interactive recipes require an interactive-capable worker", 409);
    }
    if (lease && lease.workerId !== worker.id) throw new FabricError("authorization_denied", "assignment worker mismatch", 403);
    const profileVolume = assignment.clone?.volumeName ?? assignment.profile?.volumeName ?? assignment.lease?.ephemeralVolumeName;
    const volumes = profileVolume ? [{ source: profileVolume, target: "/fabric/profile", readOnly: false }] : [];
    if (!profileVolume && recipe.mode !== "headless") throw new FabricError("validation_failed", "interactive/headful browser requires a profile volume", 400);
    // Current Chromium deliberately keeps DevTools on loopback even when a
    // remote-debugging address flag asks for a wider bind. Managed containers
    // therefore expose a Fabric-owned TCP bridge on their private worker
    // network while Chromium itself remains loopback-only on 9222. Federated
    // local workers retain their direct loopback CDP endpoint.
    const chromiumDebugPort = 9222;
    const managedCdpBridgePort = 9223;
    const managedBrowser = !worker.isLocal;
    const cdpPort = managedBrowser ? managedCdpBridgePort : chromiumDebugPort;
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
        // Managed workers use the Fabric-owned launcher for both headless and
        // interactive leases so their private CDP bridge is always present.
        // Federated local workers retain their native desktop session.
        ...(managedBrowser
          ? ["/usr/local/bin/fabric-chromium-launch", "/usr/bin/chromium"]
          : ["/usr/bin/chromium"]),
        ...(recipe.mode === "headless" ? ["--headless=new"] : []),
        ...(recipe.mode === "interactive" ? ["--start-maximized"] : []),
        ...(recipe.launch.disableServiceWorkers ? ["--disable-service-worker"] : []),
        ...recipe.launch.launchFlags,
        // These flags are appended after immutable recipe flags so no recipe can override the
        // browser ownership, debugging boundary, or routing policy.
        // The managed launcher's bridge is the only private-overlay listener.
        // Chromium's own DevTools server is intentionally loopback-only.
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${chromiumDebugPort}`,
        `--user-data-dir=${profileVolume ? "/fabric/profile/chromium" : "/tmp/fabric-browser-profile"}`,
        // Docker's no-new-privileges setting deliberately disables Debian's
        // setuid sandbox. Managed browser containers use Chromium's user
        // namespace sandbox instead, enabled by the dedicated reviewed seccomp
        // profile selected by the controller.
        ...(!worker.isLocal ? ["--disable-setuid-sandbox"] : []),
        `--proxy-pac-url=${internalEgressPacUrl(policy, { baseUrl: process.env.FABRIC_EGRESS_PAC_BASE_URL, localWorker: worker.isLocal })}`,
        "--proxy-auto-detect=false",
        "--proxy-bypass-list=<-loopback>",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"
      ],
      environment,
      volumes,
      networks: runtimeNetworks(policy),
      limits: worker.resourceLimits,
      security: { dockerSocketMounted: false, hostHomeMounted: false, repositoryMounted: false, applicationSecretsMounted: false },
      cdpBind: { host: worker.isLocal ? "127.0.0.1" : "private-overlay", port: cdpPort },
      turnstileGuardian: turnstileGuardianSpecFromEnvironment(),
      ...(assignment.challengeHandlerSet ? { challengeHandlers: assignment.challengeHandlerSet.handlers } : {}),
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
      image: assignment.recipe.browserImage,
      browserVersion: "none",
      command: ["/usr/local/bin/fabric-media-relay"],
      environment: { FABRIC_WORKER_ID: worker.id, FABRIC_JOB_ID: assignment.job.id, FABRIC_EGRESS_POLICY_REF: policy.ref },
      volumes: [],
      networks: ["fabric-workers", "fabric-egress"],
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
  for (const family of ["chromium-cdp", "patchright", "rebrowser-puppeteer"]) registry.register(new GenericBrowserRuntime(family));
  registry.register(new MediaRelayRuntime());
  return registry;
}

export function artifactChecksum(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
export * from "./browser-fingerprint";
export * from "./captcha-solvers/types";
export * from "./captcha-solvers/http";
export * from "./captcha-solvers/registry";
export * from "./captcha-solvers/death-by-captcha";
export * from "./captcha-solvers/anticaptcha";
export * from "./captcha-solvers/recaptcha-page";
export * from "./cdp-connection";
export * from "./chromium";
export * from "./turnstile-guardian";
export * from "./challenge-handlers";
export * from "./datadome-slider";
export type { MousePoint, MouseStep, RandomSource } from "./trusted-mouse";
