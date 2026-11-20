import { ChromiumProcessSupervisor } from "@browser-fabric/worker-runtime";
import type { BrowserProcessSpec, Executor } from "@browser-fabric/worker-manager";
import { captchaSolvingFromEnvironment, type CaptchaSolving } from "@browser-fabric/worker-manager";

/**
 * Local browsers read the CAPTCHA model key and token provider credentials from owner-only secret files
 * on the operator's machine, and reach the model gateway and providers through the loopback egress
 * sidecar's captcha-solver listener, never directly. Without a configured solver proxy, local guardians
 * solve only challenges that need no model, and never buy a token.
 */
export async function localCaptchaSolving(): Promise<Pick<CaptchaSolving, "captchaGuardianFactory" | "tokenSolverFor"> | Record<string, never>> {
  const proxy = process.env.FABRIC_CAPTCHA_SOLVER_PROXY_URL?.trim();
  if (!proxy) return {};
  const { captchaGuardianFactory, tokenSolverFor } = await captchaSolvingFromEnvironment(proxy);
  return { captchaGuardianFactory, tokenSolverFor };
}

/** Builds the local supervisor after its solver credentials have been read from owner-only files. */
export async function createLocalChromiumSupervisor(): Promise<ChromiumProcessSupervisor> {
  return new ChromiumProcessSupervisor({
    executablePath: process.env.FABRIC_CHROMIUM_EXECUTABLE,
    profileRoot: process.env.FABRIC_LOCAL_PROFILE_ROOT,
    cwd: process.env.FABRIC_LOCAL_WORKDIR ?? "/tmp",
    startupTimeoutMs: Number(process.env.FABRIC_BROWSER_STARTUP_TIMEOUT_MS ?? 20_000),
    ...await localCaptchaSolving(),
  });
}

/** In-process executor for a local interactive worker. Managed nodes use DockerContainerExecutor. */
export class ChromiumSupervisorExecutor implements Executor {
  readonly #supervisor: ChromiumProcessSupervisor;
  public constructor(supervisor: ChromiumProcessSupervisor) { this.#supervisor = supervisor; }
  public async start(spec: BrowserProcessSpec): Promise<{ processId: string; cdpBrowserEndpoint?: string }> {
    const result = await this.#supervisor.start(spec.container);
    return result;
  }
  public stop(processId: string): Promise<void> { return this.#supervisor.stop(processId); }
  public isRunning(processId: string): boolean { return this.#supervisor.isRunning(processId); }
}
