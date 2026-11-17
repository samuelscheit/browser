import type { EgressPolicy } from "@browser-fabric/contracts";
import { FabricError, isLoopbackHostname } from "@browser-fabric/contracts";

/**
 * Built-in listeners of the egress sidecar (deploy/compose/egress-sidecar.json). Browsers select a
 * listener through the per-policy PAC; the worker manager sends token-solver API traffic through
 * the `captcha-solver` listener.
 */
export const egressSidecarListeners = {
  direct: { id: "direct", port: 11_000 },
  /** The deployment's upstream proxy (or ordered list); its URL lives only in the sidecar's secret. */
  proxy: { id: "proxy", port: 11_001 },
  tor: { id: "tor", port: 11_002 },
  /** Token-solver API traffic only; the listener admits the solver provider hostnames and nothing else. */
  captchaSolver: { id: "captcha-solver", port: 11_003 },
} as const;

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
