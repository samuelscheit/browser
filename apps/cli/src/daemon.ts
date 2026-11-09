import { readFileSync } from "node:fs";
import type { BrowserBackend } from "./backend";
import { loadCredentials, readState, removeState, writeState, processAlive, type BrowserRequest, type DaemonState } from "./config";
import { EndpointServer } from "./endpoint-server";
import { LocalBackend } from "./local-backend";
import { fabricClient, RemoteBackend } from "./remote-backend";

const liveViewHtml = () => readFileSync(new URL("./live-view.html", import.meta.url), "utf8");

/** Long-running process behind `fabric up`; its stdout/stderr go to the browser's log file. */
export async function runDaemon(request: BrowserRequest): Promise<void> {
  const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
  const previous = readState(request.name);
  const state: DaemonState = { request, pid: process.pid, startedAt: new Date().toISOString(), status: "starting", updatedAt: new Date().toISOString() };
  const publish = (patch: Partial<DaemonState>) => {
    Object.assign(state, patch, { updatedAt: new Date().toISOString() });
    writeState(state);
  };
  publish({});

  let backend: BrowserBackend;
  try {
    if (request.mode === "remote") {
      const credentials = loadCredentials();
      // A crashed predecessor may still hold the persistent profile; give it back first.
      if (previous?.sessionId && !processAlive(previous.pid)) {
        await fabricClient(credentials).browserSessions.release(previous.sessionId).catch(() => undefined);
        log(`released session ${previous.sessionId} left by a previous daemon`);
      }
      backend = new RemoteBackend({ credentials, request, log, onSession: (sessionId) => publish({ sessionId }) });
    } else {
      backend = new LocalBackend({ request, log });
    }
  } catch (error) {
    publish({ status: "failed", error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }

  const server = new EndpointServer({
    backend,
    port: request.port,
    idleMs: request.idleMinutes * 60_000,
    liveViewHtml: liveViewHtml(),
    log,
    onStateChange: (status) => publish({ status, browser: backend.describe().detail }),
  });
  let stopping = false;
  const shutdown = async (code: number) => {
    if (stopping) return;
    stopping = true;
    log("stopping");
    await server.stop().catch(() => undefined);
    await backend.close().catch(() => undefined);
    if (code === 0) removeState(request.name);
    process.exit(code);
  };
  process.once("SIGTERM", () => void shutdown(0));
  process.once("SIGINT", () => void shutdown(0));

  try {
    server.listen();
  } catch (error) {
    publish({ status: "failed", error: `Cannot listen on 127.0.0.1:${request.port} (${error instanceof Error ? error.message : String(error)}). Another browser or debugger may use this port; pass --port.` });
    await shutdown(1);
    return;
  }
  log(`listening on http://127.0.0.1:${request.port}`);
  try {
    await server.warm();
  } catch (error) {
    publish({ status: "failed", error: error instanceof Error ? error.message : String(error) });
    await shutdown(1);
  }
}
