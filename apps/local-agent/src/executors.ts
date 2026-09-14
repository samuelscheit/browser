import { ChromiumProcessSupervisor } from "@browser-fabric/worker-runtime";
import type { BrowserProcessSpec, Executor } from "@browser-fabric/worker-manager";

/** In-process executor for a local interactive worker. Managed nodes use DockerServiceExecutor. */
export class ChromiumSupervisorExecutor implements Executor {
  readonly #supervisor: ChromiumProcessSupervisor;
  public constructor(supervisor = new ChromiumProcessSupervisor({
    executablePath: process.env.FABRIC_CHROMIUM_EXECUTABLE,
    profileRoot: process.env.FABRIC_LOCAL_PROFILE_ROOT,
    cwd: process.env.FABRIC_LOCAL_WORKDIR ?? "/tmp",
    startupTimeoutMs: Number(process.env.FABRIC_BROWSER_STARTUP_TIMEOUT_MS ?? 20_000),
  })) { this.#supervisor = supervisor; }
  public async start(spec: BrowserProcessSpec): Promise<{ processId: string; cdpBrowserEndpoint?: string }> {
    const result = await this.#supervisor.start(spec.container);
    return result;
  }
  public stop(processId: string): Promise<void> { return this.#supervisor.stop(processId); }
  public isRunning(processId: string): boolean { return this.#supervisor.isRunning(processId); }
}
