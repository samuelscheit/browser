import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync } from "node:fs";

import WebSocket, { WebSocketServer } from "ws";

const MAX_CONNECTIONS = 16;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_HTTP_BODY_BYTES = 256 * 1024;
const MAX_HTTP_RESPONSE_BYTES = 1024 * 1024;
const MAX_BUFFERED_MESSAGES = 64;
const DEFAULT_READY_TIMEOUT_MS = 120_000;

export type CdpRelayConfig = {
  apiBaseUrl: string;
  cdpGatewayBaseUrl: string;
  headers: Readonly<Record<string, string>>;
  maxConnections: number;
  readyTimeoutMs: number;
};

export type ParsedCdpSessionRoute = {
  sessionId: string;
};

export type ParsedClientApiRoute = {
  path: string;
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

function secretValue(environment: Record<string, string | undefined>, name: string): string {
  const file = environment[`${name}_FILE`]?.trim();
  let value: string | undefined;
  try {
    value = file ? readFileSync(file, "utf8").trim() : environment[name]?.trim();
  } catch {
    throw new Error(`${name} must be a non-empty secret of 24 to 4096 characters`);
  }
  if (!value || value.length < 24 || value.length > 4096 || /[\0\r\n]/.test(value)) {
    throw new Error(`${name} must be a non-empty secret of 24 to 4096 characters`);
  }
  return value;
}

function apiUsername(value: string): string {
  if (!/^principal_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error("FABRIC_API_USERNAME must be an opaque Fabric principal ID");
  }
  return value;
}

function cdpGatewayBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("FABRIC_CDP_GATEWAY_URL must be a valid WebSocket origin");
  }
  if (!["ws:", "wss:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("FABRIC_CDP_GATEWAY_URL must be a credential-free WebSocket origin");
  }
  return parsed.toString().replace(/\/$/, "");
}

/**
 * The application receives only an opaque session path. The short-lived Fabric
 * capability remains exclusively in relay memory after a password-authenticated
 * API lookup.
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

/**
 * Expose only the browser-session lifecycle operations required by an
 * application adapter. Session reads stay private because they may contain a
 * short-lived CDP capability.
 */
export function parseClientApiRoute(raw: string, method: string | undefined): ParsedClientApiRoute | undefined {
  if (method !== "POST") return undefined;
  let url: URL;
  try {
    url = new URL(raw, "http://fabric-client-relay.invalid");
  } catch {
    return undefined;
  }
  if (url.search || url.hash) return undefined;
  if (url.pathname === "/v1/browser-sessions") return { path: "/browser-sessions" };
  const match = /^\/v1\/browser-sessions\/(browser-session_[A-Za-z0-9][A-Za-z0-9_-]{0,255})\/(heartbeat|release|cancel)$/.exec(url.pathname);
  return match ? { path: `/browser-sessions/${encodeURIComponent(match[1]!)}/${match[2]}` } : undefined;
}

function boundedHeader(value: string | undefined, maximum: number): string | undefined {
  if (!value || value.length > maximum || /[\0\r\n]/.test(value)) return undefined;
  return value;
}

async function boundedRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_HTTP_BODY_BYTES) throw new Error("client API request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sanitizeApiJson(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...(value as Record<string, unknown>) };
  delete result.cdpEndpoint;
  delete result.capability;
  return result;
}

async function relayApiRequest(request: IncomingMessage, response: import("node:http").ServerResponse, config: CdpRelayConfig, route: ParsedClientApiRoute): Promise<void> {
  try {
    const body = await boundedRequestBody(request);
    const bodyText = body.toString("utf8");
    const idempotencyKey = boundedHeader(request.headers["idempotency-key"] as string | undefined, 512);
    const upstream = await globalThis.fetch(`${config.apiBaseUrl}${route.path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        ...config.headers,
        ...(bodyText ? { "content-type": "application/json" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      ...(bodyText ? { body: bodyText } : {}),
    });
    const raw = Buffer.from(await upstream.arrayBuffer());
    if (raw.length > MAX_HTTP_RESPONSE_BYTES) throw new Error("Fabric API response is too large");
    if (raw.length === 0) {
      response.writeHead(upstream.status, { "cache-control": "no-store" });
      response.end();
      return;
    }
    const json = sanitizeApiJson(JSON.parse(raw.toString("utf8")));
    response.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(json));
  } catch {
    response.writeHead(502, { "content-type": "application/problem+json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ detail: "Fabric client relay request failed" }));
  }
}

export function relayConfigFromEnvironment(environment: Record<string, string | undefined> = process.env): CdpRelayConfig {
  const username = apiUsername(requiredEnvironment(environment, "FABRIC_API_USERNAME"));
  const password = secretValue(environment, "FABRIC_API_PASSWORD");
  return {
    apiBaseUrl: fabricApiBaseUrl(requiredEnvironment(environment, "FABRIC_API_URL")),
    cdpGatewayBaseUrl: cdpGatewayBaseUrl(requiredEnvironment(environment, "FABRIC_CDP_GATEWAY_URL")),
    headers: {
      authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
    },
    maxConnections: boundedInteger(environment.FABRIC_CDP_RELAY_MAX_CONNECTIONS, "FABRIC_CDP_RELAY_MAX_CONNECTIONS", 4, 1, MAX_CONNECTIONS),
    readyTimeoutMs: boundedInteger(environment.FABRIC_CDP_RELAY_READY_TIMEOUT_MS, "FABRIC_CDP_RELAY_READY_TIMEOUT_MS", DEFAULT_READY_TIMEOUT_MS, 1_000, 300_000),
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
    return (endpoint.protocol === "ws:" || endpoint.protocol === "wss:")
      && !endpoint.username
      && !endpoint.password
      && /^\/v1\/cdp\/browser-session_[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(endpoint.pathname)
      && endpoint.searchParams.size === 1
      && Boolean(endpoint.searchParams.get("cap"));
  } catch {
    return false;
  }
}

function privateCdpEndpoint(value: string, baseUrl: string): string {
  const endpoint = new URL(value);
  const base = new URL(baseUrl);
  return `${base.protocol}//${base.host}${endpoint.pathname}?${endpoint.searchParams.toString()}`;
}

async function fabricSession(config: CdpRelayConfig, route: ParsedCdpSessionRoute): Promise<{ status?: unknown; cdpEndpoint?: unknown }> {
  let response: Response;
  try {
    response = await globalThis.fetch(fabricSessionUrl(config, route), {
      headers: { accept: "application/json", ...config.headers },
    });
  } catch {
    throw new Error("Fabric API session lookup failed");
  }
  if (!response.ok) throw new Error(`Fabric API session lookup returned HTTP ${response.status}`);
  const session = await response.json().catch(() => undefined) as { status?: unknown; cdpEndpoint?: unknown } | undefined;
  if (!session || typeof session !== "object") throw new Error("Fabric API session lookup returned an invalid response");
  return session;
}

/**
 * Resolve only an endpoint that Fabric has made ready. Applications may open
 * their opaque local relay connection as soon as they create a session; this
 * bounded poll keeps the Fabric capability entirely inside relay memory.
 */
export async function resolveFabricCdpEndpoint(
  config: CdpRelayConfig,
  route: ParsedCdpSessionRoute,
  options: { now?: () => number; wait?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + config.readyTimeoutMs;
  let delayMs = 100;
  while (true) {
    const session = await fabricSession(config, route);
    if ((session.status === "ready" || session.status === "active") && validCdpEndpoint(session.cdpEndpoint)) {
      return privateCdpEndpoint(session.cdpEndpoint, config.cdpGatewayBaseUrl);
    }
    if (["released", "cancelled", "failed", "timed_out"].includes(String(session.status))) {
      throw new Error(`Fabric session ended in ${String(session.status)}`);
    }
    if (now() >= deadline) throw new Error("Fabric session did not become ready before the relay deadline");
    await wait(Math.min(delayMs, Math.max(1, deadline - now())));
    delayMs = Math.min(2_000, Math.ceil(delayMs * 1.5));
  }
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
    const apiRoute = parseClientApiRoute(request.url ?? "/", request.method);
    if (apiRoute) {
      void relayApiRequest(request, response, config, apiRoute);
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
