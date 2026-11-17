import { lookup } from "node:dns/promises";
import { createServer as createTcpServer, Socket, connect as connectNet } from "node:net";
import { connect as connectTls, type ConnectionOptions } from "node:tls";
import { FabricError } from "@browser-fabric/contracts";
import type { EgressListenerConfig, EgressProxyEndpoint } from "./config";

const MAX_HEADER_BYTES = 64 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 2 * 60_000;
const HTTP_STATUS_LIMIT = 8 * 1024;
const MAX_STICKY_CLIENTS = 16_384;
const STICKY_CLIENT_TTL_MS = 2 * 60 * 60_000;

export interface ProxyListener {
  readonly listener: EgressListenerConfig;
  ready(): Promise<void>;
  close(): Promise<void>;
}

interface ParsedRequest {
  readonly method: string;
  readonly target: string;
  readonly version: string;
  readonly headers: readonly string[];
  readonly rest: Buffer;
}

interface Target {
  readonly host: string;
  readonly port: number;
  readonly pathname?: string;
  readonly absoluteUrl?: string;
}

interface StickySelection {
  index: number;
  lastUsedAt: number;
}

function failure(message: string, status = 502): FabricError {
  return new FabricError("worker_unavailable", message, status);
}

function isIpv4(value: string): boolean {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isPrivateIpv4(value: string): boolean {
  if (!isIpv4(value)) return false;
  const [a, b] = value.split(".").map(Number) as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function isPrivateIpv6(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
}

function obviousPrivateHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local") || normalized.endsWith(".internal") || normalized === "metadata.google.internal" || isPrivateIpv4(normalized) || isPrivateIpv6(normalized);
}

/** Pick the dial address: the first permitted record of the preferred family, else the first permitted record. */
export function selectDialAddress(
  records: readonly { address: string; family: number }[],
  allowPrivateTargets: boolean,
  preferredFamily?: 4 | 6,
): string | undefined {
  const permitted = records.filter((record) => allowPrivateTargets || !(isPrivateIpv4(record.address) || isPrivateIpv6(record.address)));
  return (permitted.find((record) => record.family === preferredFamily) ?? permitted[0])?.address;
}

async function resolvePublicHost(host: string, allowPrivateTargets: boolean, preferredFamily?: 4 | 6): Promise<string> {
  if (!host || host.length > 253 || obviousPrivateHost(host)) {
    if (allowPrivateTargets) return host;
    throw failure("egress target is not a public host", 403);
  }
  if (isIpv4(host) || host.includes(":")) return host;
  let records: Awaited<ReturnType<typeof lookup>>[];
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw failure("egress target DNS lookup failed", 502);
  }
  const address = selectDialAddress(records, allowPrivateTargets, preferredFamily);
  if (!address) throw failure("egress target resolved only to private addresses", 403);
  return address;
}

/**
 * Check every destination before handing it to an HTTP/SOCKS upstream.  Remote-DNS transports
 * still receive the original hostname to preserve policy semantics, but they do not get a chance
 * to tunnel obviously private or locally-resolving targets through a proxy.
 */
function assertPublicTarget(target: Target, allowPrivateTargets: boolean): void {
  if (!allowPrivateTargets && (!target.host || target.host.length > 253 || obviousPrivateHost(target.host))) {
    throw failure("egress target is not a public host", 403);
  }
}

function parseAuthority(value: string): Target {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || /[\s\0\r\n]/.test(trimmed)) throw failure("proxy request authority is invalid", 400);
  let host: string;
  let port: number;
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close < 0 || trimmed[close + 1] !== ":") throw failure("proxy request authority is invalid", 400);
    host = trimmed.slice(1, close);
    port = Number(trimmed.slice(close + 2));
  } else {
    const separator = trimmed.lastIndexOf(":");
    if (separator <= 0 || trimmed.indexOf(":") !== separator) throw failure("proxy request authority must include host and port", 400);
    host = trimmed.slice(0, separator);
    port = Number(trimmed.slice(separator + 1));
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) throw failure("proxy request authority is invalid", 400);
  return { host, port };
}

function parseHttpTarget(value: string): Target {
  let url: URL;
  try { url = new URL(value); } catch { throw failure("HTTP proxy requests must use an absolute HTTP URL", 400); }
  if (url.protocol !== "http:" || url.username || url.password || !url.hostname) throw failure("HTTP proxy target is invalid", 400);
  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw failure("HTTP proxy target port is invalid", 400);
  return { host: url.hostname, port, pathname: `${url.pathname || "/"}${url.search}`, absoluteUrl: url.toString() };
}

function readHeader(socket: Socket, maxBytes = MAX_HEADER_BYTES): Promise<{ header: Buffer; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let settled = false;
    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };
    const done = (error?: Error, value?: { header: Buffer; rest: Buffer }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value!);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength > maxBytes) {
        done(failure("proxy request headers exceed limit", 431));
        return;
      }
      const boundary = buffered.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      socket.pause();
      done(undefined, { header: buffered.subarray(0, boundary + 4), rest: buffered.subarray(boundary + 4) });
    };
    const onError = () => done(failure("proxy client connection failed"));
    const onClose = () => done(failure("proxy client disconnected", 499));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.resume();
  });
}

function parseRequest(header: Buffer, rest: Buffer): ParsedRequest {
  const lines = header.toString("latin1").split("\r\n");
  const requestLine = lines.shift();
  if (!requestLine) throw failure("proxy request is empty", 400);
  const [method, target, version, ...extra] = requestLine.split(" ");
  if (!method || !target || version !== "HTTP/1.1" || extra.length > 0 || !/^[A-Z]{1,16}$/.test(method)) throw failure("proxy request line is invalid", 400);
  const headers = lines.filter(Boolean);
  for (const line of headers) if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:\s*[^\r\n]*$/.test(line)) throw failure("proxy request header is invalid", 400);
  return { method, target, version, headers, rest };
}

function upstreamCredentials(endpoint: EgressProxyEndpoint): string | undefined {
  if (!endpoint.username && !endpoint.password) return undefined;
  const value = `${endpoint.username ?? ""}:${endpoint.password ?? ""}`;
  return `Basic ${Buffer.from(value, "utf8").toString("base64")}`;
}

function connectSocket(host: string, port: number, tls = false): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const options = { host, port, ...(tls ? { servername: host } : {}) } as ConnectionOptions;
    const socket = tls ? connectTls(options) : connectNet({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(failure("egress upstream connection timed out"));
    }, CONNECT_TIMEOUT_MS);
    const ready = () => { clearTimeout(timer); cleanup(); resolve(socket); };
    const failed = () => { clearTimeout(timer); cleanup(); socket.destroy(); reject(failure("egress upstream connection failed")); };
    const cleanup = () => { socket.removeListener(tls ? "secureConnect" : "connect", ready); socket.removeListener("error", failed); };
    socket.once(tls ? "secureConnect" : "connect", ready);
    socket.once("error", failed);
  });
}

async function connectDirect(target: Target, listener: EgressListenerConfig): Promise<Socket> {
  const address = await resolvePublicHost(target.host, listener.allowPrivateTargets === true, listener.preferredAddressFamily);
  return connectSocket(address, target.port);
}

async function readProxyResponse(socket: Socket): Promise<{ status: number; rest: Buffer }> {
  const { header, rest } = await readHeader(socket, HTTP_STATUS_LIMIT);
  const firstLine = header.toString("latin1").split("\r\n", 1)[0] ?? "";
  const match = /^HTTP\/1\.[01]\s+(\d{3})\b/.exec(firstLine);
  if (!match) throw failure("upstream proxy returned an invalid response");
  return { status: Number(match[1]), rest };
}

async function connectHttpProxy(endpoint: EgressProxyEndpoint, target: Target): Promise<{ socket: Socket; rest: Buffer }> {
  const socket = await connectSocket(endpoint.host, endpoint.port, endpoint.protocol === "https");
  const authorization = upstreamCredentials(endpoint);
  socket.write([
    `CONNECT ${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port} HTTP/1.1`,
    `Host: ${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}`,
    "Proxy-Connection: keep-alive",
    ...(authorization ? [`Proxy-Authorization: ${authorization}`] : []),
    "",
    "",
  ].join("\r\n"));
  const response = await readProxyResponse(socket);
  if (response.status < 200 || response.status >= 300) {
    socket.destroy();
    throw failure("egress upstream proxy rejected CONNECT", 502);
  }
  return { socket, rest: response.rest };
}

function ipv6Bytes(value: string): Buffer {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized.includes(":")) throw failure("SOCKS target address is invalid", 400);
  const [leftText, rightText] = normalized.split("::", 2);
  const left = leftText ? leftText.split(":") : [];
  const right = rightText ? rightText.split(":") : [];
  if (normalized.split("::").length > 2 || left.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) || right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    throw failure("SOCKS IPv6 target address is invalid", 400);
  }
  // An embedded IPv4 address occupies two 16-bit pieces. It is rare for an egress destination,
  // but accepting it avoids silently changing the resolver semantics of a legitimate endpoint.
  const expand = (parts: string[]): string[] => {
    const last = parts.at(-1);
    if (last && isIpv4(last)) return [...parts.slice(0, -1), ...last.split(".").map((part) => Number(part).toString(16)).reduce<string[]>((result, part, index, all) => index % 2 === 0 ? [...result, ((Number.parseInt(part, 16) << 8) + Number.parseInt(all[index + 1] ?? "0", 16)).toString(16)] : result, [])];
    return parts;
  };
  const leftParts = expand(left);
  const rightParts = expand(right);
  const zeros = 8 - leftParts.length - rightParts.length;
  const parts = normalized.includes("::") ? [...leftParts, ...Array(Math.max(0, zeros)).fill("0"), ...rightParts] : leftParts;
  if (parts.length !== 8 || (!normalized.includes("::") && leftParts.length !== 8)) throw failure("SOCKS IPv6 target address is invalid", 400);
  const bytes = Buffer.allocUnsafe(16);
  parts.forEach((part, index) => bytes.writeUInt16BE(Number.parseInt(part, 16), index * 2));
  return bytes;
}

function socksAddress(target: Target, useDomain: boolean, address?: string): Buffer {
  if (useDomain) {
    const name = Buffer.from(target.host, "utf8");
    if (name.byteLength < 1 || name.byteLength > 253) throw failure("SOCKS target hostname is invalid", 400);
    return Buffer.concat([Buffer.from([3, name.byteLength]), name]);
  }
  const resolved = address ?? target.host;
  if (isIpv4(resolved)) return Buffer.from([1, ...resolved.split(".").map(Number)]);
  return Buffer.concat([Buffer.from([4]), ipv6Bytes(resolved)]);
}

function readExact(socket: Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let settled = false;
    const cleanup = () => { socket.removeListener("data", onData); socket.removeListener("error", onError); socket.removeListener("close", onClose); };
    const done = (error?: Error, value?: Buffer) => { if (settled) return; settled = true; cleanup(); if (error) reject(error); else resolve(value!); };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength < length) return;
      socket.pause();
      const value = buffered.subarray(0, length);
      const extra = buffered.subarray(length);
      if (extra.byteLength) socket.unshift(extra);
      done(undefined, value);
    };
    const onError = () => done(failure("SOCKS upstream connection failed"));
    const onClose = () => done(failure("SOCKS upstream disconnected"));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.resume();
  });
}

async function connectSocks5(endpoint: EgressProxyEndpoint, target: Target, allowPrivateTargets: boolean): Promise<Socket> {
  const socket = await connectSocket(endpoint.host, endpoint.port);
  const auth = Boolean(endpoint.username || endpoint.password);
  socket.write(Buffer.from([5, auth ? 2 : 1, ...(auth ? [0, 2] : [0])]));
  const greeting = await readExact(socket, 2);
  if (greeting[0] !== 5 || greeting[1] === 0xff) { socket.destroy(); throw failure("SOCKS5 upstream rejected authentication", 502); }
  if (greeting[1] === 2) {
    const username = Buffer.from(endpoint.username ?? "", "utf8");
    const password = Buffer.from(endpoint.password ?? "", "utf8");
    if (username.byteLength > 255 || password.byteLength > 255 || password.byteLength === 0) { socket.destroy(); throw failure("SOCKS5 credential shape is invalid", 502); }
    socket.write(Buffer.concat([Buffer.from([1, username.byteLength]), username, Buffer.from([password.byteLength]), password]));
    const authResponse = await readExact(socket, 2);
    if (authResponse[1] !== 0) { socket.destroy(); throw failure("SOCKS5 upstream rejected credentials", 502); }
  } else if (greeting[1] !== 0) { socket.destroy(); throw failure("SOCKS5 upstream selected an unsupported authentication method", 502); }
  const remoteDns = endpoint.protocol === "socks5h";
  const address = remoteDns ? undefined : await resolvePublicHost(target.host, allowPrivateTargets);
  const targetAddress = socksAddress(target, remoteDns, address);
  const port = Buffer.allocUnsafe(2);
  port.writeUInt16BE(target.port);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), targetAddress, port]));
  const head = await readExact(socket, 4);
  if (head[0] !== 5 || head[1] !== 0) { socket.destroy(); throw failure("SOCKS5 upstream rejected CONNECT", 502); }
  const addressLength = head[3] === 1 ? 4 : head[3] === 3 ? (await readExact(socket, 1))[0]! : head[3] === 4 ? 16 : 0;
  if (!addressLength) { socket.destroy(); throw failure("SOCKS5 upstream response is invalid", 502); }
  await readExact(socket, addressLength + 2);
  return socket;
}

async function connectSocks4(endpoint: EgressProxyEndpoint, target: Target, allowPrivateTargets: boolean): Promise<Socket> {
  if (endpoint.password) throw failure("SOCKS4 upstream does not support a password credential", 502);
  const socket = await connectSocket(endpoint.host, endpoint.port);
  const port = Buffer.allocUnsafe(2);
  port.writeUInt16BE(target.port);
  const user = Buffer.from(endpoint.username ?? "", "utf8");
  // SOCKS4 has no remote-DNS mode in Fabric. Resolve locally and reject IPv6 rather than silently
  // switching to SOCKS4a (which would violate the policy's documented DNS semantics).
  const address = await resolvePublicHost(target.host, allowPrivateTargets);
  if (!isIpv4(address)) { socket.destroy(); throw failure("SOCKS4 target did not resolve to IPv4", 502); }
  socket.write(Buffer.concat([Buffer.from([4, 1]), port, Buffer.from(address.split(".").map(Number)), user, Buffer.from([0])]));
  const response = await readExact(socket, 8);
  if (response[1] !== 90) { socket.destroy(); throw failure("SOCKS4 upstream rejected CONNECT", 502); }
  return socket;
}

async function connectViaEndpoint(endpoint: EgressProxyEndpoint, target: Target, allowPrivateTargets: boolean): Promise<{ socket: Socket; rest?: Buffer }> {
  if (endpoint.protocol === "http" || endpoint.protocol === "https") return connectHttpProxy(endpoint, target);
  if (endpoint.protocol === "socks4") return { socket: await connectSocks4(endpoint, target, allowPrivateTargets) };
  return { socket: await connectSocks5(endpoint, target, allowPrivateTargets) };
}

/**
 * Execute an immutable listener strategy. The order in its secret/config is intentional (for
 * example a primary -> secondary -> direct proxy strategy); we only fall through before
 * any browser bytes are sent to an upstream, so retrying cannot duplicate a provider request.
 */
async function connectViaListener(
  listener: EgressListenerConfig,
  endpoints: readonly EgressProxyEndpoint[],
  target: Target,
  selection: StickySelection | undefined,
): Promise<{ socket: Socket; rest?: Buffer; selectedIndex?: number }> {
  if (listener.allowedHostnameSuffixes?.length) {
    const hostname = target.host.toLowerCase().replace(/^\[|\]$/g, "");
    const permitted = listener.allowedHostnameSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
    if (!permitted) throw failure("egress listener does not permit this target hostname", 403);
  }
  if (listener.mode === "direct") return { socket: await connectDirect(target, listener) };
  if (endpoints.length === 0) {
    if (listener.fallbackToDirect) return { socket: await connectDirect(target, listener) };
    throw failure("egress listener has no configured upstream", 503);
  }
  let lastError: unknown;
  const start = selection?.index ?? 0;
  for (let offset = 0; offset < endpoints.length; offset += 1) {
    const index = (start + offset) % endpoints.length;
    const endpoint = endpoints[index];
    if (!endpoint) continue;
    try {
      const connected = await connectViaEndpoint(endpoint, target, listener.allowPrivateTargets === true);
      return { ...connected, selectedIndex: index };
    } catch (error) {
      lastError = error;
    }
  }
  if (listener.fallbackToDirect) return { socket: await connectDirect(target, listener) };
  throw lastError instanceof Error ? lastError : failure("egress proxy strategy failed", 502);
}

function cleanHeaders(headers: readonly string[], extra: readonly string[] = []): string[] {
  const removed = new Set(["proxy-authorization", "proxy-connection", "connection"]);
  const result = headers.filter((line) => !removed.has(line.slice(0, line.indexOf(":")).toLowerCase()));
  return [...result, ...extra];
}

/** Preserve only the close semantic of the client Connection header, not arbitrary hop-by-hop names. */
function connectionCloseHeader(headers: readonly string[]): string[] {
  const value = headers.find((line) => line.slice(0, line.indexOf(":")).toLowerCase() === "connection")?.slice("connection:".length) ?? "";
  return /(?:^|,)\s*close\s*(?:,|$)/i.test(value) ? ["Connection: close"] : [];
}

function tunnel(client: Socket, upstream: Socket, initialToUpstream: Buffer, initialToClient?: Buffer): void {
  client.setTimeout(IDLE_TIMEOUT_MS);
  upstream.setTimeout(IDLE_TIMEOUT_MS);
  const closeBoth = () => { client.destroy(); upstream.destroy(); };
  client.once("error", closeBoth);
  upstream.once("error", closeBoth);
  client.once("timeout", closeBoth);
  upstream.once("timeout", closeBoth);
  client.once("close", () => upstream.destroy());
  upstream.once("close", () => client.destroy());
  if (initialToClient?.byteLength) client.write(initialToClient);
  if (initialToUpstream.byteLength) upstream.write(initialToUpstream);
  client.pipe(upstream);
  upstream.pipe(client);
}

function writeResponse(socket: Socket, status: number, text: string): void {
  try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
}

async function handleConnect(
  client: Socket,
  request: ParsedRequest,
  listener: EgressListenerConfig,
  endpoints: readonly EgressProxyEndpoint[],
  selection: StickySelection | undefined,
  rememberSelection: (index: number | undefined) => void,
): Promise<void> {
  const target = parseAuthority(request.target);
  assertPublicTarget(target, listener.allowPrivateTargets === true);
  const connection = await connectViaListener(listener, endpoints, target, selection);
  rememberSelection(connection.selectedIndex);
  client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: Browser-Fabric\r\n\r\n");
  tunnel(client, connection.socket, request.rest, connection.rest);
}

async function handleHttp(
  client: Socket,
  request: ParsedRequest,
  listener: EgressListenerConfig,
  endpoints: readonly EgressProxyEndpoint[],
  selection: StickySelection | undefined,
  rememberSelection: (index: number | undefined) => void,
): Promise<void> {
  const target = parseHttpTarget(request.target);
  assertPublicTarget(target, listener.allowPrivateTargets === true);
  const rewritten = `${request.method} ${target.pathname} ${request.version}\r\n${cleanHeaders(request.headers, connectionCloseHeader(request.headers)).join("\r\n")}\r\n\r\n`;
  const connection = await connectViaListener(listener, endpoints, target, selection);
  rememberSelection(connection.selectedIndex);
  tunnel(client, connection.socket, Buffer.concat([Buffer.from(rewritten, "latin1"), request.rest]), connection.rest);
}

/** Start a fail-closed internal forward proxy listener for one immutable egress policy route. */
export function startProxyListener(listener: EgressListenerConfig, endpoints: readonly EgressProxyEndpoint[]): ProxyListener {
  const sticky = new Map<string, StickySelection>();
  // Each client address keeps the upstream it last succeeded with, so one browser does not hop
  // between exits of a proxy list mid-session.
  const connectionKey = (client: Socket): string => `client:${client.remoteAddress ?? crypto.randomUUID()}`;
  const selectionFor = (key: string): StickySelection | undefined => {
    if (listener.mode === "direct") return undefined;
    const current = sticky.get(key);
    if (current && Date.now() - current.lastUsedAt <= STICKY_CLIENT_TTL_MS && current.index < endpoints.length) {
      current.lastUsedAt = Date.now();
      return current;
    }
    if (current) sticky.delete(key);
    return undefined;
  };
  const rememberFor = (key: string, index: number | undefined): void => {
    if (listener.mode === "direct" || index === undefined) return;
    if (sticky.size >= MAX_STICKY_CLIENTS && !sticky.has(key)) {
      const expired = [...sticky.entries()].find(([, value]) => Date.now() - value.lastUsedAt > STICKY_CLIENT_TTL_MS)?.[0] ?? sticky.keys().next().value;
      if (expired) sticky.delete(expired);
    }
    sticky.set(key, { index, lastUsedAt: Date.now() });
  };
  const server = createTcpServer({ pauseOnConnect: true }, (client) => {
    void (async () => {
      try {
        client.setTimeout(CONNECT_TIMEOUT_MS);
        const { header, rest } = await readHeader(client);
        const request = parseRequest(header, rest);
        client.setTimeout(0);
        const key = connectionKey(client);
        const selection = selectionFor(key);
        if (request.method === "CONNECT") await handleConnect(client, request, listener, endpoints, selection, (index) => rememberFor(key, index));
        else await handleHttp(client, request, listener, endpoints, selection, (index) => rememberFor(key, index));
      } catch (error) {
        const status = error instanceof FabricError ? error.status : 502;
        writeResponse(client, status === 403 ? 403 : status === 400 ? 400 : 502, "Bad Gateway");
      }
    })();
  });
  const ready = new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(); };
    const cleanup = () => { server.removeListener("error", onError); server.removeListener("listening", onListening); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(listener.port, listener.bindHost ?? "0.0.0.0");
  });
  // Keep a non-throwing listener after startup; connection-level failures are handled per client
  // and a late server error must not crash the sidecar process or reveal upstream details.
  server.on("error", () => undefined);
  return {
    listener,
    ready: () => ready,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
