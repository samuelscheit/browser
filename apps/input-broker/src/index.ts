import { FabricError } from "@browser-fabric/contracts";
import { MemoryEncryptedInputBroker, type EphemeralInputEnvelope } from "@browser-fabric/control-plane";

export interface InputBrokerServerOptions {
  broker?: MemoryEncryptedInputBroker;
  /** Return true only after the private mesh/mTLS layer authenticated the caller. */
  authenticate?(request: Request): Promise<boolean> | boolean;
  maxEnvelopeBytes?: number;
  allowedServices?: readonly string[];
}

function problem(error: unknown): Response {
  const body = error instanceof FabricError ? error.toProblem() : new FabricError("internal_error", "input broker failure", 500).toProblem();
  return new Response(JSON.stringify(body), { status: error instanceof FabricError ? error.status : 500, headers: { "content-type": "application/problem+json; charset=utf-8" } });
}
function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } }); }
function assertInternal(request: Request, allowedServices: ReadonlySet<string>): string {
  if (request.headers.get("x-fabric-mtls-verified") !== "true") throw new FabricError("authentication_required", "input broker requires verified service mTLS", 401);
  const service = request.headers.get("x-fabric-service");
  if (!service || !/^[a-z][a-z0-9-]{0,63}$/.test(service)) throw new FabricError("authentication_required", "input broker service identity is required", 401);
  if (!allowedServices.has(service)) throw new FabricError("authorization_denied", "service is not allowed to use the input broker", 403);
  return service;
}
async function parseEnvelope(request: Request, maxBytes: number): Promise<EphemeralInputEnvelope> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new FabricError("validation_failed", "encrypted envelope is too large", 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new FabricError("validation_failed", "encrypted envelope is too large", 413);
  try { return JSON.parse(raw) as EphemeralInputEnvelope; } catch { throw new FabricError("validation_failed", "encrypted envelope must be valid JSON", 400); }
}

export function createInputBrokerFetch(options: InputBrokerServerOptions = {}): (request: Request) => Promise<Response> {
  const broker = options.broker ?? new MemoryEncryptedInputBroker();
  const maxEnvelopeBytes = options.maxEnvelopeBytes ?? 128 * 1024;
  const allowedServices = new Set(options.allowedServices ?? ["fabric-api", "fabric-worker-manager", "fabric-local-agent"]);
  return async (request) => {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") return json({ status: "ok" });
      if (options.authenticate && !(await options.authenticate(request))) throw new FabricError("authentication_required", "input broker service authentication failed", 401);
      const service = assertInternal(request, allowedServices);
      const match = /^\/v1\/input-envelopes\/([^/]+)$/.exec(url.pathname);
      if (match) {
        const requestId = decodeURIComponent(match[1]!);
        if (request.method === "POST") {
          const envelope = await parseEnvelope(request, maxEnvelopeBytes);
          broker.put(requestId, envelope);
          return json({ accepted: true }, 202);
        }
        if (request.method === "GET") {
          if (service !== "fabric-worker-manager" && service !== "fabric-local-agent") throw new FabricError("authorization_denied", "only workers may retrieve encrypted inputs", 403);
          const workerId = url.searchParams.get("workerId");
          if (!workerId) throw new FabricError("validation_failed", "workerId is required", 400);
          return json(broker.take(requestId, workerId));
        }
        if (request.method === "DELETE") {
          if (service !== "fabric-api" && service !== "fabric-worker-manager" && service !== "fabric-local-agent") throw new FabricError("authorization_denied", "service may not discard encrypted inputs", 403);
          broker.discard(requestId);
          return json({ deleted: true });
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/input-envelopes/expire") {
        if (service !== "fabric-input-broker" && service !== "fabric-api") throw new FabricError("authorization_denied", "service may not expire broker entries", 403);
        return json({ deleted: broker.expire() });
      }
      throw new FabricError("not_found", "input broker route not found", 404);
    } catch (error) { return problem(error); }
  };
}

if (import.meta.main) {
  const broker = new MemoryEncryptedInputBroker();
  const port = Number(process.env.PORT ?? 8083);
  const tlsCertificate = process.env.FABRIC_INPUT_BROKER_CERT_FILE;
  const tlsKey = process.env.FABRIC_INPUT_BROKER_KEY_FILE;
  const tlsCa = process.env.FABRIC_INPUT_BROKER_CLIENT_CA_FILE;
  if ((tlsCertificate || tlsKey || tlsCa) && !(tlsCertificate && tlsKey && tlsCa)) throw new Error("broker TLS requires certificate, key, and client CA files together");
  const serverOptions: Bun.Serve.Options<never> = {
    port,
    maxRequestBodySize: 128 * 1024,
    fetch: createInputBrokerFetch({ broker }),
    ...(tlsCertificate && tlsKey && tlsCa ? { tls: { cert: Bun.file(tlsCertificate), key: Bun.file(tlsKey), ca: Bun.file(tlsCa), requestCert: true, rejectUnauthorized: true } } : {})
  };
  Bun.serve(serverOptions);
  const interval = setInterval(() => broker.expire(), 5_000);
  const shutdown = () => { clearInterval(interval); process.exit(0); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  console.info(`Browser Fabric encrypted input broker listening on :${port}`);
}
