import type { Worker } from "@browser-fabric/contracts";
import { AssignmentVerifier, createBunMtlsFetch } from "@browser-fabric/control-plane";
import { FabricWorkerAgent, WorkerHeartbeatAgent } from "./agent";
import { ChromiumSupervisorExecutor } from "./executors";
import { LocalAgentHttpTransport } from "./transport";

async function secret(name: string): Promise<string> {
  const file = process.env[`${name}_FILE`];
  if (file) return (await Bun.file(file).text()).trim();
  const value = process.env[name];
  if (!value) throw new Error(`${name} or ${name}_FILE is required`);
  return value;
}

async function workerConfig(): Promise<Worker> {
  const file = process.env.FABRIC_WORKER_CONFIG_FILE;
  const inline = process.env.FABRIC_WORKER_CONFIG_JSON;
  if (!file && !inline) throw new Error("FABRIC_WORKER_CONFIG_FILE or FABRIC_WORKER_CONFIG_JSON is required");
  const parsed = JSON.parse(inline ?? await Bun.file(file!).text()) as Worker;
  if (!parsed.id || !parsed.capabilities || !parsed.resourceLimits) throw new Error("worker config is incomplete");
  const fingerprint = process.env.FABRIC_WORKER_CERT_FINGERPRINT;
  const publicKeyFile = process.env.FABRIC_INPUT_PUBLIC_KEY_FILE;
  const publicKey = publicKeyFile ? (await Bun.file(publicKeyFile).text()).trim() : process.env.FABRIC_INPUT_PUBLIC_KEY_PEM;
  return {
    ...parsed,
    ...(fingerprint ? { certificateFingerprint: fingerprint } : {}),
    ...(publicKey ? { inputEncryptionPublicKeyPem: publicKey } : {})
  };
}

if (import.meta.main) {
  const worker = await workerConfig();
  const publicKey = await secret("FABRIC_ASSIGNMENT_PUBLIC_KEY");
  const managerUrl = process.env.FABRIC_WORKER_MANAGER_URL;
  if (!managerUrl) throw new Error("FABRIC_WORKER_MANAGER_URL is required");
  const clientCertificateFile = process.env.FABRIC_WORKER_CLIENT_CERT_FILE;
  const clientKeyFile = process.env.FABRIC_WORKER_CLIENT_KEY_FILE;
  const clientCaFile = process.env.FABRIC_WORKER_CLIENT_CA_FILE ?? process.env.FABRIC_WORKER_CA_FILE;
  if (!clientCertificateFile || !clientKeyFile || !clientCaFile) throw new Error("worker-manager mTLS client certificate, key, and CA are required");
  const enrollmentFile = process.env.FABRIC_WORKER_ENROLLMENT_TOKEN_FILE;
  const enrollmentToken = enrollmentFile ? (await Bun.file(enrollmentFile).text()).trim() : process.env.FABRIC_WORKER_ENROLLMENT_TOKEN;
  if (!enrollmentToken || new TextEncoder().encode(enrollmentToken).byteLength < 24) throw new Error("FABRIC_WORKER_ENROLLMENT_TOKEN is required and must be at least 24 bytes");
  const transport = new LocalAgentHttpTransport({
    baseUrl: managerUrl,
    fetch: createBunMtlsFetch({ certificateFile: clientCertificateFile, keyFile: clientKeyFile, caFile: clientCaFile }),
    assignmentVerifier: new AssignmentVerifier(publicKey),
    headers: {
      "x-fabric-worker-cert-fingerprint": worker.certificateFingerprint,
      "x-fabric-worker-enrollment": enrollmentToken,
      "x-fabric-mtls-verified": "true"
    }
  });
  if (!worker.isLocal && process.env.FABRIC_MANAGED_MODE === "1") {
    // Managed workers only register/heartbeat. The controller-side process owns the Swarm socket
    // and creates one hardened browser service per assignment.
    const heartbeatAgent = new WorkerHeartbeatAgent({ worker, transport });
    await heartbeatAgent.start();
    const shutdown = () => { heartbeatAgent.stop(); process.exit(0); };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    console.info(`Browser Fabric managed worker heartbeat agent started (${worker.id})`);
    await new Promise<void>(() => undefined);
  }
  // A local federated worker starts its browser process itself; it has no inbound public port.
  const executor = new ChromiumSupervisorExecutor();
  const agent = new FabricWorkerAgent({ worker, transport, executor });
  await agent.start();
  const shutdown = () => void agent.stop().finally(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  console.info(`Browser Fabric ${worker.isLocal ? "local" : "managed"} worker agent started (${worker.id})`);
  await new Promise<void>(() => undefined);
}
