import { ChromiumProcessSupervisor, type TokenCaptchaSolver } from "@browser-fabric/worker-runtime";
import type { ChallengeHandler } from "@browser-fabric/contracts";
import type { BrowserProcessSpec, Executor } from "@browser-fabric/worker-manager";
import { captchaTokenSolverFor, readOptionalSecret } from "@browser-fabric/worker-manager";

/**
 * Local browsers resolve solver credentials from owner-only secret files on the operator's machine. They
 * reach the providers through the loopback egress sidecar's captcha-solver listener, never directly.
 * Without a configured solver proxy, no local browser ever solves a token.
 */
export async function localCaptchaTokenSolverFor(): Promise<(handlers: readonly ChallengeHandler[] | undefined) => TokenCaptchaSolver | undefined> {
  const proxy = process.env.FABRIC_CAPTCHA_SOLVER_PROXY_URL?.trim();
  if (!proxy) return () => undefined;
  return captchaTokenSolverFor({
    providerProxyUrl: proxy,
    deathByCaptchaUsername: await readOptionalSecret(process.env.FABRIC_DEATHBYCAPTCHA_USERNAME_FILE),
    deathByCaptchaPassword: await readOptionalSecret(process.env.FABRIC_DEATHBYCAPTCHA_PASSWORD_FILE),
    antiCaptchaClientKey: await readOptionalSecret(process.env.FABRIC_ANTICAPTCHA_CLIENT_KEY_FILE),
  });
}

/** Builds the local supervisor after its solver credentials have been read from owner-only files. */
export async function createLocalChromiumSupervisor(): Promise<ChromiumProcessSupervisor> {
  return new ChromiumProcessSupervisor({
    executablePath: process.env.FABRIC_CHROMIUM_EXECUTABLE,
    profileRoot: process.env.FABRIC_LOCAL_PROFILE_ROOT,
    cwd: process.env.FABRIC_LOCAL_WORKDIR ?? "/tmp",
    startupTimeoutMs: Number(process.env.FABRIC_BROWSER_STARTUP_TIMEOUT_MS ?? 20_000),
    tokenSolverFor: await localCaptchaTokenSolverFor(),
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
