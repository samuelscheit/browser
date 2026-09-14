import type { EgressPolicy, TrafficClass } from "@browser-fabric/contracts";
import { FabricError } from "@browser-fabric/contracts";

/**
 * The deployment's egress sidecar exposes only these non-secret internal listeners. Browser
 * traffic selects a listener through the generated PAC; native workers (Social/media) use this
 * mapping to reach the same sidecar without receiving an upstream proxy credential.
 */
export const egressSidecarListeners = {
  direct: { id: "direct", port: 11_000 },
  signup: { id: "signup-proxy", port: 11_001 },
  reporting: { id: "reporting-residential", port: 11_002 },
  media: { id: "media-proxy", port: 11_003 },
  social: { id: "social-fallback", port: 11_004 },
  tor: { id: "tor", port: 11_005 },
  reportingSolver: { id: "reporting-solver", port: 11_006 },
  mediaDirect: { id: "media-direct", port: 11_007 },
} as const;

export type EgressSidecarListenerName = keyof typeof egressSidecarListeners;

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

/** Resolve the reviewed native-worker listener, including exact hostname direct exceptions. */
export function egressSidecarListenerForPolicy(policy: EgressPolicy, trafficClass?: TrafficClass, targetUrl?: string): EgressSidecarListenerName {
  const effectiveClass = directException(policy, targetUrl) ? "direct_exception" : trafficClass;
  if (policy.family === "signup-direct-assets") {
    return effectiveClass === "static_asset" || effectiveClass === "direct_exception" ? "direct" : "signup";
  }
  if (policy.family === "reporting-residential") return effectiveClass === "captcha_solver" ? "reportingSolver" : "reporting";
  if (policy.family === "media-proxy-affinity") return effectiveClass === "direct_exception" ? "mediaDirect" : "media";
  if (policy.family === "social-proxy-fallback") return "social";
  if (policy.family === "tor-egress") return "tor";
  if (policy.family === "direct-egress") return "direct";
  throw new FabricError("validation_failed", `egress policy ${policy.ref} has no Fabric sidecar listener`, 400);
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
  const listener = egressSidecarListeners[egressSidecarListenerForPolicy(policy, options.trafficClass, options.targetUrl)];
  return `http://${host}:${listener.port}`;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
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
  if (options.localWorker && !isLoopbackHost(base.hostname)) {
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
