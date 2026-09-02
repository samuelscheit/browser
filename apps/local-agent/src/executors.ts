import { ChromiumProcessSupervisor } from "@browser-fabric/worker-runtime";
import type { BrowserProcessSpec, Executor } from "@browser-fabric/worker-manager";

/** In-process executor for a local interactive worker. Managed nodes use DockerServiceExecutor. */
export class ChromiumSupervisorExecutor implements Executor {
  readonly #supervisor: ChromiumProcessSupervisor;
  public constructor(supervisor = new ChromiumProcessSupervisor()) { this.#supervisor = supervisor; }
  public async start(spec: BrowserProcessSpec): Promise<{ processId: string; cdpBrowserEndpoint?: string }> {
    const result = await this.#supervisor.start(spec.container);
    return result;
  }
  public stop(processId: string): Promise<void> { return this.#supervisor.stop(processId); }
}
