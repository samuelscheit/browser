import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

import WebSocket, { WebSocketServer } from "ws";

const MAX_CONNECTIONS = 16;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_HTTP_BODY_BYTES = 256 * 1024;
const MAX_HTTP_RESPONSE_BYTES = 1024 * 1024;
const MAX_BUFFERED_MESSAGES = 64;
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const CANCEL_TIMEOUT_MS = 10_000;

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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeApiJson(value: unknown): unknown {
  if (!isJsonObject(value)) return value;
  const result = { ...value };
  delete result.cdpEndpoint;
  delete result.capability;
  return result;
}

/** Undefined for an empty or non-JSON body (e.g. a proxy's HTML error page). */
function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown, contentType = "application/json"): void {
  response.writeHead(status, { "content-type": `${contentType}; charset=utf-8`, "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

/** Every relay error is an RFC 9457 problem object, shaped like the Fabric API's own problems. */
export function relayProblem(status: number, code: string, detail: string): Record<string, unknown> {
  return { type: `https://browser-fabric.dev/problems/${code}`, title: code.replaceAll("_", " "), status, detail, code };
}

function writeProblem(response: ServerResponse, status: number, code: string, detail: string): void {
  writeJson(response, status, relayProblem(status, code, detail), "application/problem+json");
}

async function relayApiRequest(request: IncomingMessage, response: ServerResponse, config: CdpRelayConfig, route: ParsedClientApiRoute): Promise<void> {
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
    const payload = parseJsonBody(raw);
    if (!upstream.ok) {
      // A client always gets a problem object for an error, never an empty, `null` or HTML body.
      if (isJsonObject(payload)) writeJson(response, upstream.status, sanitizeApiJson(payload), "application/problem+json");
      else writeProblem(response, upstream.status, "fabric_api_error", `Fabric API request failed with HTTP ${upstream.status}`);
      return;
    }
    if (raw.length === 0) {
      response.writeHead(upstream.status, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (payload === undefined) throw new Error("Fabric API returned a non-JSON response");
    writeJson(response, upstream.status, sanitizeApiJson(payload));
  } catch {
    writeProblem(response, 502, "relay_failed", "Fabric client relay request failed");
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

/** The session reached a terminal status; there is nothing left to cancel. */
export class FabricSessionEndedError extends Error {}

/** The session stayed unready past the relay's readiness deadline. */
export class FabricSessionReadyTimeoutError extends Error {}

async function fabricSession(config: CdpRelayConfig, route: ParsedCdpSessionRoute, signal?: AbortSignal): Promise<{ status?: unknown; cdpEndpoint?: unknown }> {
  let response: Response;
  try {
    response = await globalThis.fetch(fabricSessionUrl(config, route), {
      headers: { accept: "application/json", ...config.headers },
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new Error("Fabric API session lookup failed");
  }
  if (!response.ok) throw new Error(`Fabric API session lookup returned HTTP ${response.status}`);
  const session = await response.json().catch(() => undefined) as { status?: unknown; cdpEndpoint?: unknown } | undefined;
  if (!session || typeof session !== "object") throw new Error("Fabric API session lookup returned an invalid response");
  return session;
}

/** Sleep that an abort ends early; the caller's loop then observes the abort. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Resolve only an endpoint that Fabric has made ready. Applications may open
 * their opaque local relay connection as soon as they create a session; this
 * bounded poll keeps the Fabric capability entirely inside relay memory.
 * `signal` stops the poll once the waiting client has gone.
 */
export async function resolveFabricCdpEndpoint(
  config: CdpRelayConfig,
  route: ParsedCdpSessionRoute,
  options: {
    now?: () => number;
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
    onStatus?: (status: unknown) => void;
  } = {},
): Promise<string> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? abortableDelay;
  const deadline = now() + config.readyTimeoutMs;
  let delayMs = 100;
  while (true) {
    options.signal?.throwIfAborted();
    const session = await fabricSession(config, route, options.signal);
    options.onStatus?.(session.status);
    if ((session.status === "ready" || session.status === "active") && validCdpEndpoint(session.cdpEndpoint)) {
      return privateCdpEndpoint(session.cdpEndpoint, config.cdpGatewayBaseUrl);
    }
    if (["released", "cancelled", "failed", "timed_out"].includes(String(session.status))) {
      throw new FabricSessionEndedError(`Fabric session ended in ${String(session.status)}`);
    }
    if (now() >= deadline) throw new FabricSessionReadyTimeoutError("Fabric session did not become ready before the relay deadline");
    await wait(Math.min(delayMs, Math.max(1, deadline - now())), options.signal);
    delayMs = Math.min(2_000, Math.ceil(delayMs * 1.5));
  }
}

/**
 * Cancel a session whose client left (or whose readiness wait failed) before it ever connected,
 * so a queued or allocating session does not hold a browser slot until its TTL. Best effort:
 * the scheduler's CDP client grace and the TTL still reclaim it when this request fails.
 */
export async function cancelFabricSession(config: CdpRelayConfig, route: ParsedCdpSessionRoute): Promise<void> {
  try {
    const response = await globalThis.fetch(`${fabricSessionUrl(config, route)}/cancel`, {
      method: "POST",
      headers: { accept: "application/json", ...config.headers },
      signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
    });
    if (!response.ok) console.warn(JSON.stringify({ event: "relay.session_cancel_failed", sessionId: route.sessionId, status: response.status }));
  } catch {
    console.warn(JSON.stringify({ event: "relay.session_cancel_failed", sessionId: route.sessionId }));
  }
}

/** Relay clients per Fabric session, so one client leaving never cancels a session another still uses. */
class SessionClients {
  readonly #clients = new Map<string, Set<WebSocket>>();

  public add(sessionId: string, client: WebSocket): void {
    const clients = this.#clients.get(sessionId) ?? new Set<WebSocket>();
    clients.add(client);
    this.#clients.set(sessionId, clients);
    client.once("close", () => {
      clients.delete(client);
      if (clients.size === 0 && this.#clients.get(sessionId) === clients) this.#clients.delete(sessionId);
    });
  }

  public hasOthers(sessionId: string, client: WebSocket): boolean {
    return [...(this.#clients.get(sessionId) ?? [])].some((other) => other !== client);
  }
}

async function relayConnection(client: WebSocket, config: CdpRelayConfig, route: ParsedCdpSessionRoute, sessions: SessionClients): Promise<void> {
  let upstream: WebSocket | undefined;
  let closed = false;
  let lastStatus: unknown;
  const clientGone = new AbortController();
  const abandon = () => {
    // Never cancel a session already observed active (a reconnecting client leaves it to reconnect grace)
    // or one still tracked by another client on this relay.
    if (lastStatus === "active") return;
    if (!sessions.hasOthers(route.sessionId, client)) void cancelFabricSession(config, route);
  };
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
  client.on("close", () => {
    closeBoth(1000, "client disconnected");
    clientGone.abort();
  });
  client.on("error", () => closeBoth(1011, "relay client error"));
  try {
    const endpoint = await resolveFabricCdpEndpoint(config, route, {
      signal: clientGone.signal,
      onStatus: (status) => { lastStatus = status; },
    });
    if (closed) {
      abandon();
      return;
    }
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
  } catch (error) {
    closeBoth(1011, "Fabric CDP session unavailable");
    if (!(error instanceof FabricSessionEndedError) && (clientGone.signal.aborted || error instanceof FabricSessionReadyTimeoutError)) {
      abandon();
    }
  }
}

export function createCdpClientRelayServer(config: CdpRelayConfig): { server: Server; close(): Promise<void> } {
  let activeConnections = 0;
  const sessions = new SessionClients();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fabric-cdp-client-relay.invalid");
    if (request.method === "GET" && url.pathname === "/healthz") {
      writeJson(response, 200, { status: "ok", activeConnections });
      return;
    }
    const apiRoute = parseClientApiRoute(request.url ?? "/", request.method);
    if (apiRoute) {
      void relayApiRequest(request, response, config, apiRoute);
      return;
    }
    writeProblem(response, 404, "not_found", "route not found");
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
      sessions.add(route.sessionId, client);
      void relayConnection(client, config, route, sessions);
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
