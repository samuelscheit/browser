import type { Server, ServerWebSocket } from "bun";

type Data = { upstream?: WebSocket; queue: (string | ArrayBuffer | Uint8Array)[] };

/**
 * Chrome's remote-debugging toggle (chrome://inspect/#remote-debugging) in front of a Chrome that
 * was started with --remote-debugging-port: `/json/*` answers 404, page sockets 403, and every
 * browser-socket upgrade is a user prompt — counted here, and answered by `prompt`: "allow"
 * (pipe to Chrome), "decline" (403 Connection rejected) or "ignore" (no answer, like an open dialog).
 */
export class ToggleProxy {
  upgrades = 0;
  prompt: "allow" | "decline" | "ignore" = "allow";
  /** Every frame a client sent to Chrome through the proxy. */
  readonly sent: Record<string, any>[] = [];
  readonly #sockets = new Set<ServerWebSocket<Data>>();
  #server?: Server<Data>;

  public constructor(readonly upstreamUrl: string) {}

  public get port(): number { return this.#server!.port!; }
  public get browserPath(): string { return new URL(this.upstreamUrl).pathname; }
  /** What Chrome writes into the user data dir for this server. */
  public get devToolsActivePort(): string { return `${this.port}\n${this.browserPath}\n`; }

  public start(): this {
    this.#server = Bun.serve<Data>({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: (request, server) => {
        const path = new URL(request.url).pathname;
        const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
        if (!upgrade) return new Response("", { status: 404 });
        if (path.startsWith("/devtools/page/")) return new Response("Connection rejected", { status: 403 });
        if (!path.startsWith("/devtools/browser/")) return new Response("", { status: 404 });
        this.upgrades += 1;
        if (this.prompt === "decline") return new Response("Connection rejected", { status: 403 });
        if (this.prompt === "ignore") return new Promise<Response>(() => undefined);
        return server.upgrade(request, { data: { queue: [] } }) ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        maxPayloadLength: 512 * 1024 * 1024,
        open: (socket) => {
          this.#sockets.add(socket);
          const upstream = new WebSocket(this.upstreamUrl);
          upstream.binaryType = "arraybuffer";
          socket.data.upstream = upstream;
          upstream.addEventListener("open", () => { for (const frame of socket.data.queue.splice(0)) upstream.send(frame); });
          upstream.addEventListener("message", (event) => socket.send(event.data as string));
          upstream.addEventListener("close", () => socket.close(1000, "browser closed"));
        },
        message: (socket, message) => {
          try { this.sent.push(JSON.parse(String(message))); } catch { /* not JSON */ }
          const upstream = socket.data.upstream!;
          if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
          else socket.data.queue.push(message);
        },
        close: (socket) => {
          this.#sockets.delete(socket);
          socket.data.upstream?.close();
        },
      },
    });
    return this;
  }

  /** Chrome quit, or the user turned the toggle off: every connection drops. */
  public dropConnections(): void {
    for (const socket of this.#sockets) socket.close(1000, "browser closed");
  }

  public stop(): void {
    this.dropConnections();
    this.#server?.stop(true);
  }
}
