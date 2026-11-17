import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

/** Chromium writes `<port>\n<browser websocket path>` into the user data dir once its DevTools server listens. */
export function parseDevToolsActivePort(contents: string): { port: number; path: string } | undefined {
  const [portLine, path] = contents.split("\n").map((line) => line.trim());
  const port = Number(portLine);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535 || !path?.startsWith("/devtools/browser/")) return undefined;
  return { port, path };
}

export function readDevToolsActivePort(userDataDir: string): { port: number; path: string } | undefined {
  try {
    return parseDevToolsActivePort(readFileSync(join(userDataDir, "DevToolsActivePort"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Whether something accepts TCP on the loopback port. The file outlives Chrome's server, so it is
 * only a hint; a bare TCP connect never triggers Chrome's "Allow remote debugging?" prompt.
 */
export function portListening(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (listening: boolean) => { clearTimeout(timer); socket.destroy(); resolve(listening); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
