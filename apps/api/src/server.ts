
import type { Principal } from "@browser-fabric/contracts";
import { createBunMtlsFetch, createPostgresScheduler, HttpEncryptedInputBroker, type PostgresSchedulerRuntime } from "@browser-fabric/control-plane";
import { createApiFetch } from "./index";

async function loadSecret(name: string): Promise<string> {
  const file = process.env[`${name}_FILE`];
  if (file) return (await Bun.file(file).text()).trim();
  const value = process.env[name];
  if (!value) throw new Error(`${name} or ${name}_FILE is required`);
  return value;
}

function optionalBrokerFetch(): ((request: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | undefined {
  const certificateFile = process.env.FABRIC_INPUT_BROKER_CLIENT_CERT_FILE;
  const keyFile = process.env.FABRIC_INPUT_BROKER_CLIENT_KEY_FILE;
  const caFile = process.env.FABRIC_INPUT_BROKER_CLIENT_CA_FILE;
  if (!certificateFile && !keyFile && !caFile) return undefined;
  if (!certificateFile || !keyFile || !caFile) throw new Error("input broker client mTLS requires certificate, key, and CA files");
  return createBunMtlsFetch({ certificateFile, keyFile, caFile });
}

export type ApiRuntime = PostgresSchedulerRuntime;

export async function createProductionApi(): Promise<ApiRuntime> {
  return createPostgresScheduler({ databaseUrl: await loadSecret("FABRIC_DB_URL"), capabilitySecret: await loadSecret("FABRIC_CAPABILITY_SECRET"), gatewayBaseUrl: process.env.FABRIC_GATEWAY_BASE_URL, poolSize: Number(process.env.FABRIC_DB_POOL_SIZE ?? 10), ssl: process.env.FABRIC_DB_SSL === "1" });
}

function principalFromHeaders(request: Request): Principal | undefined {
  // These headers are accepted only after the private ingress has verified the client
  // certificate and forwarded the verification result. Direct callers cannot self-assert them.
  if (request.headers.get("x-fabric-mtls-verified") !== "true") return undefined;
  const id = request.headers.get("x-fabric-principal");
  const project = request.headers.get("x-fabric-project");
  const fingerprint = request.headers.get("x-fabric-cert-fingerprint");
  if (!id || !project || !fingerprint) return undefined;
  return { id: id as Principal["id"], displayName: id, projectGrants: [project as Principal["projectGrants"][number]], roles: ["project_operator"], certificateFingerprint: fingerprint, createdAt: new Date().toISOString() };
}

if (import.meta.main) {
  const runtime = await createProductionApi();
  const brokerUrl = process.env.FABRIC_INPUT_BROKER_URL;
  const encryptedInputBroker = brokerUrl ? new HttpEncryptedInputBroker({ baseUrl: brokerUrl, serviceName: "fabric-api", fetch: optionalBrokerFetch(), headers: { "x-fabric-mtls-verified": "true" } }) : undefined;
  const port = Number(process.env.PORT ?? 8080);
  Bun.serve({ port, fetch: createApiFetch({ scheduler: runtime.scheduler, authenticate: principalFromHeaders, ...(encryptedInputBroker ? { encryptedInputBroker } : {}) }) });
  console.info(`Browser Fabric API listening on :${port}`);
  process.once("SIGTERM", () => void runtime.close());
}
