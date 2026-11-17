import { createServer } from "node:http";
import { FabricError } from "@browser-fabric/contracts";
import { loadEgressConfig, loadListenerEndpoints, type EgressPacPolicy, type EgressSidecarConfig, type PacRule } from "./config";
import { startProxyListener, type ProxyListener } from "./proxy";

const PAC_PORT = Number(process.env.FABRIC_EGRESS_PAC_PORT ?? 8080);
const PAC_HOST = process.env.FABRIC_EGRESS_PAC_HOST?.trim() || "fabric-egress-sidecar";
const PAC_BIND_HOST = process.env.FABRIC_EGRESS_BIND_HOST?.trim() || "0.0.0.0";

function escapePac(value: string): string {
  return JSON.stringify(value);
}

function matcher(rule: PacRule): string {
  const terms: string[] = [];
  for (const suffix of rule.hostnameSuffixes ?? []) {
    const normalized = suffix.toLowerCase().replace(/^\./, "");
    terms.push(`(host === ${escapePac(normalized)} || dnsDomainIs(host, ${escapePac(`.${normalized}`)}))`);
  }
  for (const extension of rule.pathExtensions ?? []) {
    const normalized = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
    terms.push(`shExpMatch(url.toLowerCase(), ${escapePac(`*${normalized}*`)})`);
  }
  for (const fragment of rule.pathContains ?? []) terms.push(`url.toLowerCase().indexOf(${escapePac(fragment.toLowerCase())}) !== -1`);
  return terms.length ? terms.join(" || ") : "false";
}

function proxyFor(policy: EgressPacPolicy, listenerId: string, listenerPorts: ReadonlyMap<string, number>, pacHost: string, includeFallback = false): string {
  const primaryPort = listenerPorts.get(listenerId);
  if (!primaryPort) throw new FabricError("validation_failed", `policy ${policy.ref} has no listener port`, 400);
  // No `DIRECT` fallback: browser containers have no external overlay attachment and a listener
  // outage must fail closed rather than silently bypass policy/credentials. An explicitly reviewed
  // direct-egress listener is still a proxy hop owned by Fabric and therefore appears as PROXY.
  const ports = [primaryPort, ...(includeFallback ? policy.fallbackListenerIds ?? [] : []).map((fallback) => {
    const port = listenerPorts.get(fallback);
    if (!port) throw new FabricError("validation_failed", `policy ${policy.ref} has an unknown fallback listener`, 400);
    return port;
  })];
  return ports.map((port) => `PROXY ${pacHost}:${port}`).join("; ");
}

export function pac(policy: EgressPacPolicy, listenerPorts: ReadonlyMap<string, number>, pacHost = PAC_HOST): string {
  const rules = (policy.rules ?? []).map((rule) => {
    // A rule is an explicit direct exception (for example static assets). It must not
    // inherit the policy's proxy fallback list: a failed direct asset is deliberately not retried
    // through a paid/account proxy.
    return `  if (${matcher(rule)}) return ${escapePac(proxyFor(policy, rule.listenerId, listenerPorts, pacHost))};`;
  }).join("\n");
  return [
    "// Browser Fabric immutable egress policy PAC. Generated inside the sidecar.",
    "function FindProxyForURL(url, host) {",
    "  host = host.toLowerCase();",
    rules,
    `  return ${escapePac(proxyFor(policy, policy.defaultListenerId, listenerPorts, pacHost, true))};`,
    "}",
    "",
  ].join("\n");
}

function contentType(pathname: string): string {
  return pathname.startsWith("/pac/") ? "application/x-ns-proxy-autoconfig; charset=utf-8" : "application/json; charset=utf-8";
}

export interface EgressSidecarHandle {
  readonly pacHost: string;
  readonly pacPort: number;
  readonly pacBaseUrl: string;
  readonly listeners: readonly ProxyListener[];
  close(): Promise<void>;
}

export interface StartEgressSidecarOptions {
  config: EgressSidecarConfig;
  /** Port zero is allowed only by the local test harness. Production config uses 8080. */
  pacPort?: number;
  pacHost?: string;
  bindHost?: "0.0.0.0" | "127.0.0.1";
}

function validatePacHost(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(value) || value.includes("..")) throw new Error("Fabric egress PAC host is invalid");
  return value;
}

/**
 * Start the policy listener set plus its PAC endpoint. This is exported so the browser integration
 * test exercises the exact sidecar that production packages, rather than a parallel mock proxy.
 */
export async function startEgressSidecar(options: StartEgressSidecarOptions): Promise<EgressSidecarHandle> {
  const configuredPort = options.pacPort ?? 8080;
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65_535 || configuredPort !== 0 && configuredPort < 1_024) throw new Error("Fabric egress PAC port is outside safe bounds");
  const pacHost = validatePacHost(options.pacHost ?? "fabric-egress-sidecar");
  const bindHost = options.bindHost ?? "0.0.0.0";
  if (bindHost !== "0.0.0.0" && bindHost !== "127.0.0.1") throw new Error("Fabric egress bind host must be 0.0.0.0 or 127.0.0.1");
  const config = options.config;
  const listenerPorts = new Map(config.listeners.map((listener) => [listener.id, listener.port]));
  const listeners = await Promise.all(config.listeners.map(async (listener) => startProxyListener(listener, await loadListenerEndpoints(listener))));
  try {
    await Promise.all(listeners.map((listener) => listener.ready()));
  } catch (error) {
    await Promise.all(listeners.map((listener) => listener.close().catch(() => undefined)));
    throw error;
  }
  const policies = new Map(config.policies.map((policy) => [policy.ref, pac(policy, listenerPorts, pacHost)]));
  const http = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${pacHost}:${configuredPort || 80}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": contentType(url.pathname), "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "ok", listeners: listeners.map((listener) => listener.listener.id), policies: [...policies.keys()] }));
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/pac/")) {
      let ref: string;
      try { ref = decodeURIComponent(url.pathname.slice("/pac/".length)); } catch { ref = ""; }
      const script = policies.get(ref);
      if (!script) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end("not found");
        return;
      }
      response.writeHead(200, { "content-type": contentType(url.pathname), "cache-control": "no-store, max-age=0" });
      response.end(script);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end("not found");
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(configuredPort, bindHost, () => { http.removeListener("error", reject); resolve(); });
  });
  const address = http.address();
  if (!address || typeof address === "string") {
    await Promise.all(listeners.map((listener) => listener.close().catch(() => undefined)));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    throw new Error("Fabric egress PAC did not bind a TCP port");
  }
  const pacPort = address.port;
  return {
    pacHost,
    pacPort,
    pacBaseUrl: `http://${pacHost}:${pacPort}`,
    listeners,
    close: async () => {
      await Promise.all(listeners.map((listener) => listener.close().catch(() => undefined)));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function main(): Promise<void> {
  if (!Number.isInteger(PAC_PORT) || PAC_PORT < 1_024 || PAC_PORT > 65_535) throw new Error("FABRIC_EGRESS_PAC_PORT is outside safe bounds");
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(PAC_HOST)) throw new Error("FABRIC_EGRESS_PAC_HOST must be a safe internal DNS name");
  if (PAC_BIND_HOST !== "0.0.0.0" && PAC_BIND_HOST !== "127.0.0.1") throw new Error("FABRIC_EGRESS_BIND_HOST must be 0.0.0.0 or 127.0.0.1");
  const configPath = process.env.FABRIC_EGRESS_CONFIG ?? "/etc/browser-fabric/egress-sidecar.json";
  const config = await loadEgressConfig(configPath);
  const sidecar = await startEgressSidecar({ config, pacPort: PAC_PORT, pacHost: PAC_HOST, bindHost: PAC_BIND_HOST });
  console.info(JSON.stringify({ event: "fabric.egress.started", pacPort: sidecar.pacPort, listeners: sidecar.listeners.map((listener) => listener.listener.id), policies: config.policies.map((policy) => policy.ref) }));
  const shutdown = async () => {
    await sidecar.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

if (import.meta.main) await main();
