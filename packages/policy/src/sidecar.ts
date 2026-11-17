import type { EgressPolicy, EgressSidecarListener, TrafficClass } from "@browser-fabric/contracts";
import { FabricError, isLoopbackHostname } from "@browser-fabric/contracts";

/**
 * The built-in listeners of the egress sidecar (deploy/compose/egress-sidecar.json). Browser traffic
 * selects a listener through the generated PAC; native workers (media relay/playback) use a policy's
 * `sidecar` routing to reach the same sidecar without receiving an upstream proxy credential.
 * Catalog policies may name further listeners the deployment adds to its sidecar config.
 */
export const egressSidecarListeners = {
  direct: { id: "direct", port: 11_000 },
  /** The deployment's upstream proxy (or proxy pool); its URL lives only in the sidecar's secret. */
  proxy: { id: "proxy", port: 11_001 },
  tor: { id: "tor", port: 11_002 },
  /** Token-solver API traffic only; the listener admits the solver provider hostnames and nothing else. */
  captchaSolver: { id: "captcha-solver", port: 11_003 },
} as const satisfies Record<string, EgressSidecarListener>;

function directException(policy: EgressPolicy, targetUrl: string | undefined): boolean {
  if (!targetUrl || !policy.directExceptionHostnames?.length) return false;
  let hostname: string;
  try {
    const url = new URL(targetUrl);
    hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    throw new FabricError("validation_failed", "egress target URL is invalid", 400);
  }
  return policy.directExceptionHostnames.some((suffix) => {
    const normalized = suffix.toLowerCase().replace(/^\./, "");
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
}

/** Validate a policy's sidecar routing: listener ids and ports the PAC/proxy URL builders can use. */
export function assertEgressSidecarRouting(policy: Pick<EgressPolicy, "ref" | "sidecar">): void {
  const listeners = [policy.sidecar?.listener, ...(policy.sidecar?.directListener ? [policy.sidecar.directListener] : [])];
  for (const listener of listeners) {
    if (!listener || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(listener.id) || !Number.isInteger(listener.port) || listener.port < 1_024 || listener.port > 65_535) {
      throw new FabricError("validation_failed", `egress policy ${policy.ref} has no valid Fabric sidecar listener`, 400);
    }
  }
}

/**
 * Resolve the sidecar listener for one request of a native worker. A `direct` route of the traffic
 * class, or a direct-exception hostname, uses the policy's direct listener when it declares one.
 */
export function egressSidecarListenerForPolicy(policy: EgressPolicy, trafficClass?: TrafficClass, targetUrl?: string): EgressSidecarListener {
  assertEgressSidecarRouting(policy);
  const routeIsDirect = directException(policy, targetUrl) || (trafficClass !== undefined && policy.routes[trafficClass]?.kind === "direct");
  return routeIsDirect && policy.sidecar.directListener ? policy.sidecar.directListener : policy.sidecar.listener;
}

/** Return a credential-free proxy URL that is only routable on Fabric's egress overlay. */
export function internalEgressProxyUrl(
  policy: EgressPolicy,
  options: { host?: string; trafficClass?: TrafficClass; targetUrl?: string } = {},
): string {
  const host = options.host ?? "fabric-egress-sidecar";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(host) || host.includes("..")) {
    throw new FabricError("validation_failed", "Fabric egress sidecar host is invalid", 400);
  }
  const listener = egressSidecarListenerForPolicy(policy, options.trafficClass, options.targetUrl);
  return `http://${host}:${listener.port}`;
}

/**
 * Return the per-policy PAC URL that Chromium is allowed to use. Managed workers use the private
 * Compose DNS name; federated local workers must use a loopback sidecar so a host browser cannot
 * fail open to the host's default route.
 */
export function internalEgressPacUrl(
  policy: EgressPolicy,
  options: { baseUrl?: string; localWorker?: boolean } = {},
): string {
  const fallback = options.localWorker ? "http://127.0.0.1:8080" : "http://fabric-egress-sidecar:8080";
  const value = options.baseUrl?.trim() || fallback;
  let base: URL;
  try { base = new URL(value); } catch { throw new FabricError("validation_failed", "Fabric egress PAC base URL must be HTTP(S)", 400); }
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password || (base.pathname !== "" && base.pathname !== "/") || base.search || base.hash) {
    throw new FabricError("validation_failed", "Fabric egress PAC base URL must be a credential-free origin", 400);
  }
  if (options.localWorker && !isLoopbackHostname(base.hostname)) {
    throw new FabricError("validation_failed", "the federated local worker must use a loopback Fabric egress PAC", 400);
  }
  base.pathname = `/pac/${encodeURIComponent(policy.ref)}`;
  return base.toString();
}

/** The PAC is security-critical: a missing/invalid script must never let Chromium use DIRECT. */
export function assertFailClosedPac(script: string): void {
  if (typeof script !== "string" || script.length < 32 || !script.includes("FindProxyForURL") || !script.includes("PROXY ") || /\bDIRECT\b/.test(script)) {
    throw new FabricError("worker_unavailable", "Fabric egress PAC is unavailable or not fail-closed", 503);
  }
}
