
import type { Principal } from "@browser-fabric/contracts";
import { ArtifactAccess, ArtifactCollector, ArtifactService, bunMtlsServerTls, certificateFingerprintFromForwardedHeader, certificateFingerprintsEqual, createBunMtlsFetch, createPostgresScheduler, createProductionObjectStore, forwardedClientCertificate, HttpEncryptedInputBroker, MediaPlaybackCapabilitySigner, mtlsFilesFromEnv, type PostgresSchedulerRuntime } from "@browser-fabric/control-plane";
import { createApiFetch } from "./index";
import { MediaPlaybackGateway } from "../../media-playback-gateway/src/index";

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

async function createMediaPlaybackGateway(runtime: PostgresSchedulerRuntime): Promise<MediaPlaybackGateway | undefined> {
  const privateKeyFile = process.env.FABRIC_MEDIA_PLAYBACK_PRIVATE_KEY_FILE;
  const privateKey = privateKeyFile ? (await Bun.file(privateKeyFile).text()).trim() : process.env.FABRIC_MEDIA_PLAYBACK_PRIVATE_KEY?.trim();
  const baseUrl = process.env.FABRIC_MEDIA_PLAYBACK_BASE_URL?.trim();
  if (!privateKey && !baseUrl) return undefined;
  if (!privateKey || !baseUrl) throw new Error("FABRIC_MEDIA_PLAYBACK_PRIVATE_KEY(_FILE) and FABRIC_MEDIA_PLAYBACK_BASE_URL must be configured together");
  const signer = new MediaPlaybackCapabilitySigner({ privateKey, gatewayBaseUrl: baseUrl });
  return new MediaPlaybackGateway({ scheduler: runtime.scheduler, signer, verifier: signer });
}

export type ApiRuntime = PostgresSchedulerRuntime;

export async function createProductionApi(): Promise<ApiRuntime> {
  return createPostgresScheduler({ databaseUrl: await loadSecret("FABRIC_DB_URL"), capabilitySecret: await loadSecret("FABRIC_CAPABILITY_SECRET"), gatewayBaseUrl: process.env.FABRIC_GATEWAY_BASE_URL, poolSize: Number(process.env.FABRIC_DB_POOL_SIZE ?? 10), ssl: process.env.FABRIC_DB_SSL === "1" });
}

async function principalFromHeaders(request: Request, scheduler: PostgresSchedulerRuntime["scheduler"]): Promise<Principal | undefined> {
  // The edge verifies an outer client certificate and forwards its DER value only over origin
  // mTLS. Do not trust caller-supplied principal/project labels: a registered certificate is the
  // sole identity, and the scheduler evaluates its grants for every requested project.
  if (request.headers.get("x-fabric-mtls-verified") !== "true") return undefined;
  const claimedFingerprint = request.headers.get("x-fabric-cert-fingerprint");
  const certificateFingerprint = certificateFingerprintFromForwardedHeader(forwardedClientCertificate(request));
  const fingerprint = certificateFingerprint ?? claimedFingerprint;
  if (!fingerprint) return undefined;
  if (process.env.NODE_ENV === "production" && !certificateFingerprint) return undefined;
  if (claimedFingerprint && certificateFingerprint && !certificateFingerprintsEqual(claimedFingerprint, certificateFingerprint)) return undefined;
  const snapshot = await scheduler.store.snapshot();
  const principals = [...snapshot.principals.values()].filter((principal) => certificateFingerprintsEqual(principal.certificateFingerprint, fingerprint));
  // Provisioning rejects duplicate certificate fingerprints. Retain this defensive ambiguity
  // check so a corrupted store cannot turn one certificate into multiple principals.
  return principals.length === 1 ? structuredClone(principals[0]!) : undefined;
}

if (import.meta.main) {
  const runtime = await createProductionApi();
  const objectStore = await createProductionObjectStore();
  const collector = new ArtifactCollector({ scheduler: runtime.scheduler, objectStore });
  const artifactService = new ArtifactService({ scheduler: runtime.scheduler, collector });
  const artifactAccess = new ArtifactAccess({ scheduler: runtime.scheduler, objectStore });
  const mediaPlaybackGateway = await createMediaPlaybackGateway(runtime);
  const brokerUrl = process.env.FABRIC_INPUT_BROKER_URL;
  const encryptedInputBroker = brokerUrl ? new HttpEncryptedInputBroker({ baseUrl: brokerUrl, serviceName: "fabric-api", fetch: optionalBrokerFetch(), headers: { "x-fabric-mtls-verified": "true" } }) : undefined;
  const port = Number(process.env.PORT ?? 8080);
  // The API is attached to the private control overlay for PostgreSQL/broker access. Origin mTLS
  // prevents another overlay workload from bypassing Traefik and forging forwarded identity
  // headers; Traefik itself presents the dedicated Fabric-origin client certificate.
  const tlsFiles = mtlsFilesFromEnv("FABRIC_API");
  if (process.env.NODE_ENV === "production" && !tlsFiles) throw new Error("fabric-api requires origin mTLS in production");
  Bun.serve({
    port,
    ...(tlsFiles ? { tls: bunMtlsServerTls(tlsFiles) } : {}),
    fetch: createApiFetch({ scheduler: runtime.scheduler, authenticate: (request) => principalFromHeaders(request, runtime.scheduler), artifactService, artifactAccess, ...(mediaPlaybackGateway ? { mediaPlaybackGateway } : {}), ...(encryptedInputBroker ? { encryptedInputBroker } : {}) }),
  });
  console.info(`Browser Fabric API listening on :${port}`);
  process.once("SIGTERM", () => void runtime.close());
}
