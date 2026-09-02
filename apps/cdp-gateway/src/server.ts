import { createPostgresScheduler, CapabilitySigner } from "@browser-fabric/control-plane";
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
    authenticate: (request) => request.headers.get("x-fabric-mtls-verified") === "true" && Boolean(request.headers.get("x-fabric-cert-fingerprint"))
  });
  const port = Number(process.env.PORT ?? 8081);
  Bun.serve(gateway.createBunServeOptions(port));
  console.info(`Browser Fabric CDP gateway listening on :${port}`);
  process.once("SIGTERM", () => void runtime.close());
}
