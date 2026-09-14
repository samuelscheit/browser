import { bunMtlsServerTls, certificateFingerprintFromForwardedHeader, certificateFingerprintsEqual, createPostgresScheduler, forwardedClientCertificate, mtlsFilesFromEnv, CapabilitySigner } from "@browser-fabric/control-plane";
import { CdpGateway, NativeWebSocketUpstream } from "./index";

async function loadSecret(name: string): Promise<string> { const file = process.env[`${name}_FILE`]; if (file) return (await Bun.file(file).text()).trim(); const value = process.env[name]; if (!value) throw new Error(`${name} or ${name}_FILE is required`); return value; }

if (import.meta.main) {
  const databaseUrl = await loadSecret("FABRIC_DB_URL");
  const capabilitySecret = await loadSecret("FABRIC_CAPABILITY_SECRET");
  const runtime = await createPostgresScheduler({ databaseUrl, capabilitySecret, gatewayBaseUrl: process.env.FABRIC_GATEWAY_BASE_URL ?? "wss://fabric.internal.example" });
  const gateway = new CdpGateway({
    scheduler: runtime.scheduler,
    capabilitySigner: new CapabilitySigner({ secret: capabilitySecret, gatewayBaseUrl: process.env.FABRIC_GATEWAY_BASE_URL ?? "wss://fabric.internal.example" }),
    upstream: new NativeWebSocketUpstream(),
    authenticate: async (request, context) => {
      if (request.headers.get("x-fabric-mtls-verified") !== "true") return false;
      const forwarded = certificateFingerprintFromForwardedHeader(forwardedClientCertificate(request));
      if (process.env.NODE_ENV === "production" && !forwarded) return false;
      const claimed = request.headers.get("x-fabric-cert-fingerprint");
      const fingerprint = forwarded ?? claimed;
      if (!fingerprint || forwarded && claimed && !certificateFingerprintsEqual(forwarded, claimed)) return false;
      // A local worker's relay is subsequently bound to its exact provisioned worker record in
      // authorizeReverseRelay. Project principals never gain the right to impersonate a worker.
      if (context.kind === "worker_relay") return true;
      if (!context.project) return false;
      const snapshot = await runtime.scheduler.store.snapshot();
      return [...snapshot.principals.values()].some((principal) =>
        certificateFingerprintsEqual(principal.certificateFingerprint, fingerprint)
        && (principal.roles.includes("fabric_admin") || principal.projectGrants.includes(context.project!)),
      );
    }
  });
  const port = Number(process.env.PORT ?? 8081);
  // As with fabric-api, only Traefik's dedicated origin certificate can reach this backend.
  // The forwarded outer client certificate is still checked for the user/worker identity.
  const tlsFiles = mtlsFilesFromEnv("FABRIC_CDP_GATEWAY");
  if (process.env.NODE_ENV === "production" && !tlsFiles) throw new Error("fabric-cdp-gateway requires origin mTLS in production");
  Bun.serve({ ...gateway.createBunServeOptions(port), ...(tlsFiles ? { tls: bunMtlsServerTls(tlsFiles) } : {}) });
  console.info(`Browser Fabric CDP gateway listening on :${port}`);
  process.once("SIGTERM", () => void runtime.close());
}
