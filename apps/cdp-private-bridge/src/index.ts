import { createServer, type IncomingMessage, type Server } from "node:http";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { createSocket } from "node:dgram";

import WebSocket, { WebSocketServer, type RawData } from "ws";

const MAX_CONNECTIONS = 8;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_BUFFERED_MESSAGES = 64;
const MAX_VERSION_RESPONSE_BYTES = 64 * 1024;

export type PrivateCdpBridgeConfig = {
  /** Exact private worker-network IPv4 address, primarily useful for deterministic tests. */
  bindAddress?: string;
  /** Fabric peer on the private worker network used to derive the correct local bind address. */
  peerHost?: string;
  listenPort: number;
  chromiumPort: number;
};

type BridgeSocketData = {
  path: string;
  closed: boolean;
  upstream?: WebSocket;
  buffered: Array<{ data: RawData; binary: boolean }>;
};

export type PrivateCdpBridge = {
  server: Server;
  bindAddress: string;
  close(): Promise<void>;
};

function validPort(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1_024 || value > 65_535) throw new Error(`${name} must be a private TCP port from 1024 to 65535`);
  return value;
}

function validBindAddress(value: string): string {
  if (isIP(value) !== 4 || value.startsWith("127.")) throw new Error("FABRIC_CDP_BRIDGE_BIND_ADDRESS must be a non-loopback IPv4 address");
  return value;
}

function validPeerHost(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(value)) throw new Error("FABRIC_CDP_BRIDGE_PEER_HOST must be a private DNS name or IPv4 address");
  return value;
}

/** Resolve the container address selected by the route to a Fabric-only peer. */
export async function privateBindAddressForPeer(peerHost: string): Promise<string> {
  const target = await lookup(validPeerHost(peerHost), { family: 4 });
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onConnect = () => { cleanup(); resolve(); };
      const cleanup = () => {
        socket.off("error", onError);
        socket.off("connect", onConnect);
      };
      socket.once("error", onError);
      socket.once("connect", onConnect);
      socket.connect(9, target.address);
    });
    const local = socket.address();
    if (typeof local === "string") throw new Error("private CDP bridge resolved an invalid local address");
    return validBindAddress(local.address);
  } finally {
    socket.close();
  }
}

function devtoolsPath(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value, "http://fabric-private-cdp-bridge.invalid");
  } catch {
    return undefined;
  }
  if (url.search || url.hash) return undefined;
  return /^\/devtools\/browser\/[A-Za-z0-9-]{1,256}$/.test(url.pathname) ? url.pathname : undefined;
}

function closeSocket(socket: WebSocket | undefined, code: number, reason: string): void {
  if (!socket || (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING)) return;
  try {
    socket.close(code, reason);
  } catch {
    socket.terminate();
  }
}

function versionUrl(config: PrivateCdpBridgeConfig): string {
  return `http://127.0.0.1:${config.chromiumPort}/json/version`;
}

function upstreamWebSocketUrl(config: PrivateCdpBridgeConfig, path: string): string {
  return `ws://127.0.0.1:${config.chromiumPort}${path}`;
}

async function chromeVersion(config: PrivateCdpBridgeConfig): Promise<string> {
  let response: Response;
  try {
    // The upstream address is loopback, so Chromium accepts the generated
    // loopback Host header. Never forward the caller-controlled bridge Host.
    response = await fetch(versionUrl(config), { signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new Error("local Chromium DevTools endpoint is unavailable");
  }
  if (!response.ok) throw new Error(`local Chromium DevTools returned HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > MAX_VERSION_RESPONSE_BYTES) throw new Error("local Chromium DevTools version response is too large");
  let parsed: { webSocketDebuggerUrl?: unknown };
  try {
    parsed = JSON.parse(body) as { webSocketDebuggerUrl?: unknown };
  } catch {
    throw new Error("local Chromium DevTools version response is invalid JSON");
  }
  if (typeof parsed.webSocketDebuggerUrl !== "string") throw new Error("local Chromium DevTools version response has no browser WebSocket endpoint");
  let endpoint: URL;
  try {
    endpoint = new URL(parsed.webSocketDebuggerUrl);
  } catch {
    throw new Error("local Chromium DevTools returned an invalid browser WebSocket endpoint");
  }
  if ((endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") || !["127.0.0.1", "localhost"].includes(endpoint.hostname) || endpoint.port !== String(config.chromiumPort) || !devtoolsPath(endpoint.pathname)) {
    throw new Error("local Chromium DevTools returned an unsafe browser WebSocket endpoint");
  }
  return body;
}

function relayConnection(client: WebSocket, data: BridgeSocketData, config: PrivateCdpBridgeConfig): void {
  const closeBoth = (code: number, reason: string) => {
    if (data.closed) return;
    data.closed = true;
    closeSocket(client, code, reason);
    closeSocket(data.upstream, code, reason);
  };

  client.on("message", (message, binary) => {
    if (data.closed) return;
    if (data.upstream?.readyState === WebSocket.OPEN) {
      data.upstream.send(message, { binary });
      return;
    }
    if (data.buffered.length >= MAX_BUFFERED_MESSAGES) {
      closeBoth(1013, "Fabric private CDP bridge backpressure");
      return;
    }
    data.buffered.push({ data: message, binary });
  });
  client.once("close", () => closeBoth(1000, "Fabric CDP client disconnected"));
  client.once("error", () => closeBoth(1011, "Fabric CDP client transport failed"));

  // This is a fixed loopback destination, not a general-purpose forward
  // proxy. Supplying the loopback Host header avoids Chromium rejecting the
  // Docker-assigned lease hostname while preserving its loopback-only listener.
  const upstream = new WebSocket(upstreamWebSocketUrl(config, data.path), {
    headers: { host: "localhost" },
    perMessageDeflate: false,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  data.upstream = upstream;
  upstream.on("open", () => {
    for (const message of data.buffered.splice(0)) {
      if (upstream.readyState !== WebSocket.OPEN) break;
      upstream.send(message.data, { binary: message.binary });
    }
  });
  upstream.on("message", (message, binary) => {
    if (!data.closed && client.readyState === WebSocket.OPEN) client.send(message, { binary });
  });
  upstream.once("close", () => closeBoth(1000, "local Chromium DevTools closed"));
  upstream.once("error", () => closeBoth(1011, "local Chromium DevTools is unavailable"));
}

function rejectUpgrade(socket: import("node:stream").Duplex, status: number): void {
  socket.write(`HTTP/1.1 ${status} ${status === 404 ? "Not Found" : "Service Unavailable"}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Start a fixed-destination CDP bridge for one lease container.
 *
 * Chromium retains its DevTools server at 127.0.0.1. This bridge derives the
 * container address selected by the route to a Fabric-only worker peer, binds
 * only that address, proxies only `/json/version` plus browser-level CDP
 * WebSockets, and rewrites the upstream Host header to loopback.
 */
export async function startPrivateCdpBridge(config: PrivateCdpBridgeConfig): Promise<PrivateCdpBridge> {
  if ((config.bindAddress === undefined) === (config.peerHost === undefined)) {
    throw new Error("Fabric private CDP bridge requires exactly one bind address source");
  }
  const normalized: PrivateCdpBridgeConfig = {
    bindAddress: config.bindAddress === undefined ? await privateBindAddressForPeer(config.peerHost!) : validBindAddress(config.bindAddress),
    listenPort: validPort(config.listenPort, "FABRIC_CDP_BRIDGE_PORT"),
    chromiumPort: validPort(config.chromiumPort, "FABRIC_CHROMIUM_CDP_PORT"),
  };
  if (normalized.listenPort === normalized.chromiumPort) throw new Error("Fabric private CDP bridge and Chromium ports must differ");

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fabric-private-cdp-bridge.invalid");
    if (request.method === "GET" && url.pathname === "/healthz" && !url.search) {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method !== "GET" || url.pathname !== "/json/version" || url.search) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    try {
      const body = await chromeVersion(normalized);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": String(Buffer.byteLength(body)) });
      response.end(body);
    } catch {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("local Chromium DevTools unavailable");
    }
  });
  const relay = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PAYLOAD_BYTES });
  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    const path = devtoolsPath(request.url ?? "");
    if (!path) {
      rejectUpgrade(socket, 404);
      return;
    }
    if (relay.clients.size >= MAX_CONNECTIONS) {
      rejectUpgrade(socket, 503);
      return;
    }
    relay.handleUpgrade(request, socket, head, (client) => {
      const data: BridgeSocketData = { path, closed: false, buffered: [] };
      relayConnection(client, data, normalized);
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(normalized.listenPort, normalized.bindAddress);
  });
  return {
    server,
    bindAddress: normalized.bindAddress!,
    close: async () => {
      for (const client of relay.clients) closeSocket(client, 1001, "Fabric private CDP bridge is stopping");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
