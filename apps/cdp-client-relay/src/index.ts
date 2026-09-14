import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync } from "node:fs";

import WebSocket, { WebSocketServer } from "ws";

const MAX_CONNECTIONS = 16;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_BUFFERED_MESSAGES = 64;

export type CdpRelayConfig = {
  apiBaseUrl: string;
  certificate: Buffer;
  key: Buffer;
  ca: Buffer;
  headers: Readonly<Record<string, string>>;
  maxConnections: number;
};

export type ParsedCdpSessionRoute = {
  sessionId: string;
};

function requiredEnvironment(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Fabric CDP client relay`);
  return value;
}

function boundedInteger(value: string | undefined, name: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function fabricApiBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("FABRIC_API_URL must be a valid HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !/^\/v1\/?$/.test(parsed.pathname)
  ) {
    throw new Error("FABRIC_API_URL must be a credential-free HTTP(S) /v1 origin");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function safeFile(value: string, name: string): Buffer {
  try {
    const bytes = readFileSync(value);
    if (bytes.byteLength === 0) throw new Error("empty");
    return bytes;
  } catch {
    throw new Error(`${name} must reference readable non-empty certificate material`);
  }
}

/**
 * Companion receives only an opaque session path. The short-lived Fabric
 * capability remains exclusively in relay memory after an mTLS API lookup.
 */
export function parseCdpSessionRoute(raw: string): ParsedCdpSessionRoute | undefined {
  let url: URL;
  try {
    url = new URL(raw, "http://fabric-cdp-client-relay.invalid");
  } catch {
    return undefined;
  }
  if (url.search || url.hash) return undefined;
  const match = /^\/v1\/cdp\/(browser-session_[A-Za-z0-9][A-Za-z0-9_-]{0,255})$/.exec(url.pathname);
  return match ? { sessionId: match[1]! } : undefined;
}

/** The relay calls only the configured Fabric API base; callers cannot choose an upstream. */
export function fabricSessionUrl(config: Pick<CdpRelayConfig, "apiBaseUrl">, route: ParsedCdpSessionRoute): string {
  return `${config.apiBaseUrl}/browser-sessions/${encodeURIComponent(route.sessionId)}`;
}

export function relayConfigFromEnvironment(environment: Record<string, string | undefined> = process.env): CdpRelayConfig {
  const certificate = safeFile(requiredEnvironment(environment, "FABRIC_CDP_RELAY_CLIENT_CERT_FILE"), "FABRIC_CDP_RELAY_CLIENT_CERT_FILE");
  const key = safeFile(requiredEnvironment(environment, "FABRIC_CDP_RELAY_CLIENT_KEY_FILE"), "FABRIC_CDP_RELAY_CLIENT_KEY_FILE");
  const ca = safeFile(requiredEnvironment(environment, "FABRIC_CDP_RELAY_CLIENT_CA_FILE"), "FABRIC_CDP_RELAY_CLIENT_CA_FILE");
  const project = requiredEnvironment(environment, "FABRIC_PROJECT");
  const principal = requiredEnvironment(environment, "FABRIC_PRINCIPAL");
  const fingerprint = requiredEnvironment(environment, "FABRIC_CERT_FINGERPRINT");
  return {
    apiBaseUrl: fabricApiBaseUrl(requiredEnvironment(environment, "FABRIC_API_URL")),
    certificate,
    key,
    ca,
    headers: {
      "x-fabric-mtls-verified": "true",
      "x-fabric-project": project,
      "x-fabric-principal": principal,
      "x-fabric-cert-fingerprint": fingerprint,
    },
    maxConnections: boundedInteger(environment.FABRIC_CDP_RELAY_MAX_CONNECTIONS, "FABRIC_CDP_RELAY_MAX_CONNECTIONS", 4, 1, MAX_CONNECTIONS),
  };
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    try {
      socket.close(code, reason);
    } catch {
      socket.terminate();
    }
  }
}

function validCdpEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 16_384) return false;
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === "wss:"
      && !endpoint.username
      && !endpoint.password
      && /^\/v1\/cdp\/browser-session_[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(endpoint.pathname)
      && endpoint.searchParams.size === 1
      && Boolean(endpoint.searchParams.get("cap"));
  } catch {
    return false;
  }
}

async function resolveFabricCdpEndpoint(config: CdpRelayConfig, route: ParsedCdpSessionRoute): Promise<string> {
  let response: Response;
  try {
    response = await globalThis.fetch(fabricSessionUrl(config, route), {
      headers: { accept: "application/json", ...config.headers },
      tls: { cert: config.certificate, key: config.key, ca: config.ca, rejectUnauthorized: true },
    } as RequestInit);
  } catch {
    throw new Error("Fabric API session lookup failed");
  }
  if (!response.ok) throw new Error(`Fabric API session lookup returned HTTP ${response.status}`);
  const session = await response.json().catch(() => undefined) as { status?: unknown; cdpEndpoint?: unknown } | undefined;
  if (!session || (session.status !== "ready" && session.status !== "active") || !validCdpEndpoint(session.cdpEndpoint)) {
    throw new Error("Fabric session is not ready for relay connection");
  }
  return session.cdpEndpoint;
}

async function relayConnection(client: WebSocket, config: CdpRelayConfig, route: ParsedCdpSessionRoute): Promise<void> {
  let upstream: WebSocket | undefined;
  let closed = false;
  const buffered: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
  const closeBoth = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    closeSocket(client, code, reason);
    if (upstream) closeSocket(upstream, code, reason);
  };
  client.on("message", (data, isBinary) => {
    if (closed) return;
    if (upstream?.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
      return;
    }
    if (buffered.length >= MAX_BUFFERED_MESSAGES) {
      closeBoth(1013, "Fabric CDP relay backpressure");
      return;
    }
    buffered.push({ data, binary: isBinary });
  });
  client.on("close", () => closeBoth(1000, "client disconnected"));
  client.on("error", () => closeBoth(1011, "relay client error"));
  try {
    const endpoint = await resolveFabricCdpEndpoint(config, route);
    if (closed) return;
    upstream = new WebSocket(endpoint, {
      cert: config.certificate,
      key: config.key,
      ca: config.ca,
      rejectUnauthorized: true,
      headers: config.headers,
      perMessageDeflate: false,
      maxPayload: MAX_PAYLOAD_BYTES,
    });
    upstream.on("open", () => {
      for (const message of buffered.splice(0)) {
        if (upstream?.readyState !== WebSocket.OPEN) break;
        upstream.send(message.data, { binary: message.binary });
      }
    });
    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    upstream.on("close", () => closeBoth(1000, "Fabric CDP connection closed"));
    upstream.on("error", () => closeBoth(1011, "Fabric CDP connection unavailable"));
  } catch {
    closeBoth(1011, "Fabric CDP session unavailable");
  }
}

export function createCdpClientRelayServer(config: CdpRelayConfig): { server: Server; close(): Promise<void> } {
  let activeConnections = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fabric-cdp-client-relay.invalid");
    if (request.method === "GET" && url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "ok", activeConnections }));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });
  const relay = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PAYLOAD_BYTES });
  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    const route = parseCdpSessionRoute(request.url ?? "");
    if (!route || activeConnections >= config.maxConnections) {
      socket.write(`HTTP/1.1 ${route ? "503 Service Unavailable" : "404 Not Found"}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    relay.handleUpgrade(request, socket, head, (client) => {
      activeConnections += 1;
      client.once("close", () => { activeConnections = Math.max(0, activeConnections - 1); });
      void relayConnection(client, config, route);
    });
  });
  return {
    server,
    close: async () => {
      for (const client of relay.clients) closeSocket(client, 1001, "relay shutting down");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
