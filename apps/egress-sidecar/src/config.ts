import { readFile } from "node:fs/promises";
import { FabricError } from "@browser-fabric/contracts";

export type ProxyProtocol = "http" | "https" | "socks4" | "socks5" | "socks5h";

export interface EgressProxyEndpoint {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface EgressListenerConfig {
  id: string;
  port: number;
  /** Overlay listeners bind all interfaces; federated local sidecars must use loopback. */
  bindHost?: "0.0.0.0" | "127.0.0.1";
  /** Direct is the only mode that is allowed to reach an origin without an upstream proxy. */
  mode: "direct" | "proxy";
  /** A non-secret endpoint may be used for an internal Tor pool or test fixture. */
  upstreamUrls?: readonly string[];
  /** Each non-empty line contains one full upstream proxy URL. Only the sidecar reads this file. */
  upstreamSecretFile?: string;
  /** Enables localhost/private-target tests only; production config must leave this false. */
  allowPrivateTargets?: boolean;
  /** Exact reviewed hostname suffixes this listener may reach; checked by the sidecar per CONNECT. */
  allowedHostnameSuffixes?: readonly string[];
  /** Permit this reviewed listener to try direct egress only after every upstream proxy fails. */
  fallbackToDirect?: boolean;
  /** Select one 0-based endpoint from a multi-entry secret such as the Social pool. */
  upstreamIndex?: number;
}

export interface PacRule {
  listenerId: string;
  hostnameSuffixes?: readonly string[];
  pathExtensions?: readonly string[];
  pathContains?: readonly string[];
}

export interface EgressPacPolicy {
  ref: string;
  defaultListenerId: string;
  /** Ordered proxy-list fallbacks; the final fallback is still a Fabric direct listener, never DIRECT. */
  fallbackListenerIds?: readonly string[];
  rules?: readonly PacRule[];
}

export interface EgressSidecarConfig {
  version: 1;
  listeners: readonly EgressListenerConfig[];
  policies: readonly EgressPacPolicy[];
}

const allowedProtocols = new Set<ProxyProtocol>(["http", "https", "socks4", "socks5", "socks5h"]);
const safeId = /^[a-z][a-z0-9-]{0,63}$/;
const safeRef = /^egress_[A-Za-z0-9][A-Za-z0-9_.-]*@\d+$/;

function fail(message: string): never {
  throw new FabricError("validation_failed", message, 400);
}

function string(value: unknown, name: string, max = 4_096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) fail(`${name} must be a bounded non-empty string`);
  return value.trim();
}

function strings(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value.map((item, index) => string(item, `${name}[${index}]`, 2_048));
}

function hostnameSuffixes(value: unknown, name: string): string[] | undefined {
  const entries = strings(value, name);
  if (entries === undefined) return undefined;
  if (entries.length < 1 || entries.length > 64) fail(`${name} must contain one to 64 hostname suffixes`);
  const normalized = entries.map((entry) => entry.toLowerCase().replace(/^\./, ""));
  if (normalized.some((entry) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(entry))) {
    fail(`${name} contains an invalid hostname suffix`);
  }
  return [...new Set(normalized)];
}

function parseListener(value: unknown, index: number): EgressListenerConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`listeners[${index}] must be an object`);
  const raw = value as Record<string, unknown>;
  const id = string(raw.id, `listeners[${index}].id`, 64);
  if (!safeId.test(id)) fail(`listeners[${index}].id is invalid`);
  const port = raw.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1_024 || port > 65_535) fail(`listeners[${index}].port is invalid`);
  const bindHost = raw.bindHost;
  if (bindHost !== undefined && bindHost !== "0.0.0.0" && bindHost !== "127.0.0.1") fail(`listeners[${index}].bindHost is invalid`);
  const mode = raw.mode;
  if (mode !== "direct" && mode !== "proxy") fail(`listeners[${index}].mode must be direct or proxy`);
  const upstreamUrls = strings(raw.upstreamUrls, `listeners[${index}].upstreamUrls`);
  const allowedHostnameSuffixes = hostnameSuffixes(raw.allowedHostnameSuffixes, `listeners[${index}].allowedHostnameSuffixes`);
  const upstreamSecretFile = raw.upstreamSecretFile === undefined ? undefined : string(raw.upstreamSecretFile, `listeners[${index}].upstreamSecretFile`, 512);
  const upstreamIndex = raw.upstreamIndex;
  const localSecretFile = process.env.FABRIC_EGRESS_LOCAL_MODE === "1" && upstreamSecretFile?.startsWith("/") && !upstreamSecretFile.includes("..");
  if (upstreamSecretFile && !upstreamSecretFile.startsWith("/run/secrets/") && !localSecretFile) {
    fail(`listeners[${index}].upstreamSecretFile must be a Docker secret path (or an absolute owner-managed local path in FABRIC_EGRESS_LOCAL_MODE=1)`);
  }
  if (mode === "direct" && (upstreamUrls?.length || upstreamSecretFile)) fail(`listeners[${index}] direct mode cannot configure an upstream`);
  if (mode === "proxy" && !upstreamUrls?.length && !upstreamSecretFile) fail(`listeners[${index}] proxy mode requires an upstream URL or secret`);
  if (allowedHostnameSuffixes && mode !== "direct") fail(`listeners[${index}].allowedHostnameSuffixes is supported only for direct listeners`);
  if (raw.fallbackToDirect === true && mode !== "proxy") fail(`listeners[${index}].fallbackToDirect requires proxy mode`);
  if (upstreamIndex !== undefined && (!Number.isInteger(upstreamIndex) || (upstreamIndex as number) < 0 || (upstreamIndex as number) > 63)) fail(`listeners[${index}].upstreamIndex is invalid`);
  return {
    id,
    port,
    ...(bindHost === undefined ? {} : { bindHost }),
    mode,
    ...(upstreamUrls?.length ? { upstreamUrls } : {}),
    ...(upstreamSecretFile ? { upstreamSecretFile } : {}),
    ...(raw.allowPrivateTargets === true ? { allowPrivateTargets: true } : {}),
    ...(allowedHostnameSuffixes === undefined ? {} : { allowedHostnameSuffixes }),
    ...(raw.fallbackToDirect === true ? { fallbackToDirect: true } : {}),
    ...(upstreamIndex === undefined ? {} : { upstreamIndex: upstreamIndex as number }),
  };
}

function parseRule(value: unknown, policyRef: string, index: number): PacRule {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`policy ${policyRef} rule ${index} must be an object`);
  const raw = value as Record<string, unknown>;
  const listenerId = string(raw.listenerId, `policy ${policyRef} rule ${index}.listenerId`, 64);
  if (!safeId.test(listenerId)) fail(`policy ${policyRef} rule ${index}.listenerId is invalid`);
  const hostnameSuffixes = strings(raw.hostnameSuffixes, `policy ${policyRef} rule ${index}.hostnameSuffixes`);
  const pathExtensions = strings(raw.pathExtensions, `policy ${policyRef} rule ${index}.pathExtensions`);
  const pathContains = strings(raw.pathContains, `policy ${policyRef} rule ${index}.pathContains`);
  if (!hostnameSuffixes?.length && !pathExtensions?.length && !pathContains?.length) fail(`policy ${policyRef} rule ${index} has no matcher`);
  return { listenerId, ...(hostnameSuffixes?.length ? { hostnameSuffixes } : {}), ...(pathExtensions?.length ? { pathExtensions } : {}), ...(pathContains?.length ? { pathContains } : {}) };
}

function parsePolicy(value: unknown, index: number): EgressPacPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`policies[${index}] must be an object`);
  const raw = value as Record<string, unknown>;
  const ref = string(raw.ref, `policies[${index}].ref`, 256);
  if (!safeRef.test(ref)) fail(`policies[${index}].ref is invalid`);
  const defaultListenerId = string(raw.defaultListenerId, `policies[${index}].defaultListenerId`, 64);
  if (!safeId.test(defaultListenerId)) fail(`policies[${index}].defaultListenerId is invalid`);
  const fallbackListenerIds = strings(raw.fallbackListenerIds, `policies[${index}].fallbackListenerIds`);
  if (fallbackListenerIds?.some((listenerId) => !safeId.test(listenerId))) fail(`policies[${index}].fallbackListenerIds contains an invalid listener`);
  let rules: PacRule[] | undefined;
  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) fail(`policies[${index}].rules must be an array`);
    rules = raw.rules.map((rule, ruleIndex) => parseRule(rule, ref, ruleIndex));
  }
  return { ref, defaultListenerId, ...(fallbackListenerIds?.length ? { fallbackListenerIds } : {}), ...(rules?.length ? { rules } : {}) };
}

export function parseEgressConfig(value: unknown): EgressSidecarConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("egress config must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) fail("egress config version must be 1");
  if (!Array.isArray(raw.listeners) || raw.listeners.length < 1 || raw.listeners.length > 32) fail("egress config requires one to 32 listeners");
  if (!Array.isArray(raw.policies) || raw.policies.length < 1 || raw.policies.length > 64) fail("egress config requires one to 64 policies");
  const listeners = raw.listeners.map(parseListener);
  const listenerIds = new Set(listeners.map((listener) => listener.id));
  if (listenerIds.size !== listeners.length || new Set(listeners.map((listener) => listener.port)).size !== listeners.length) fail("listener IDs and ports must be unique");
  const policies = raw.policies.map(parsePolicy);
  if (new Set(policies.map((policy) => policy.ref)).size !== policies.length) fail("policy refs must be unique");
  for (const policy of policies) {
    if (!listenerIds.has(policy.defaultListenerId)) fail(`policy ${policy.ref} references an unknown default listener`);
    for (const listenerId of policy.fallbackListenerIds ?? []) if (!listenerIds.has(listenerId)) fail(`policy ${policy.ref} references an unknown fallback listener`);
    for (const rule of policy.rules ?? []) if (!listenerIds.has(rule.listenerId)) fail(`policy ${policy.ref} references an unknown rule listener`);
  }
  return { version: 1, listeners, policies };
}

export async function loadEgressConfig(path: string): Promise<EgressSidecarConfig> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); } catch { fail("egress configuration must be readable JSON"); }
  return parseEgressConfig(parsed);
}

/** Parse an upstream URL but deliberately never include it in an error response or log. */
export function parseProxyEndpoint(value: string, allowCredentials: boolean): EgressProxyEndpoint {
  let url: URL;
  try { url = new URL(value.trim()); } catch { fail("egress upstream URL is invalid"); }
  const protocol = url.protocol.slice(0, -1) as ProxyProtocol;
  if (!allowedProtocols.has(protocol) || !url.hostname || url.pathname !== "/" && url.pathname !== "" || url.search || url.hash) fail("egress upstream URL has an unsupported shape");
  if (!allowCredentials && (url.username || url.password)) fail("egress configuration must not embed proxy credentials");
  const port = Number(url.port || (protocol === "https" ? 443 : protocol.startsWith("socks") ? 1080 : 8080));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) fail("egress upstream port is invalid");
  return {
    protocol,
    host: url.hostname,
    port,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

export async function loadListenerEndpoints(listener: EgressListenerConfig): Promise<readonly EgressProxyEndpoint[]> {
  if (listener.mode === "direct") return [];
  const urls = [...(listener.upstreamUrls ?? [])];
  if (listener.upstreamSecretFile) {
    let secret: string;
    try { secret = await readFile(listener.upstreamSecretFile, "utf8"); } catch { fail(`egress credential secret for listener ${listener.id} is unavailable`); }
    for (const line of secret.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) urls.push(trimmed);
    }
  }
  if (urls.length < 1 || urls.length > 64) fail(`listener ${listener.id} has no usable upstreams`);
  const endpoints = urls.map((url) => parseProxyEndpoint(url, true));
  if (listener.upstreamIndex !== undefined) {
    const endpoint = endpoints[listener.upstreamIndex];
    if (!endpoint) fail(`listener ${listener.id} requested an unavailable upstream index`);
    return [endpoint];
  }
  return endpoints;
}
