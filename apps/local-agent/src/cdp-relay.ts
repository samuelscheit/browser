/**
 * Outbound-only CDP relay for the federated local worker.
 *
 * One relay is opened per claimed lease. The first socket terminates at the
 * Fabric gateway; the second terminates at the local browser's browser-level
 * CDP endpoint. Frames are copied unchanged in both directions. Bun's
 * WebSocket client supports mTLS/TLS and custom headers, so the local worker
 * never needs an inbound listener or a public browser port.
 */
import type { WorkerId } from "@browser-fabric/contracts";

export interface CdpRelayOptions {
  gatewayUrl: string;
  workerId: WorkerId;
  leaseId: string;
  browserEndpoint: string;
  headers?: Record<string, string>;
  tls?: { ca?: unknown; cert?: unknown; key?: unknown; rejectUnauthorized?: boolean };
  socketFactory?: (url: string, options?: Record<string, unknown>) => WebSocket;
  openTimeoutMs?: number;
}

function replaceTemplate(template: string, workerId: WorkerId, leaseId: string): string {
  const url = template.replaceAll("{workerId}", encodeURIComponent(workerId)).replaceAll("{leaseId}", encodeURIComponent(leaseId));
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("FABRIC_CDP_RELAY_URL must be a valid WebSocket URL"); }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new Error("FABRIC_CDP_RELAY_URL must use ws:// or wss://");
  if (parsed.username || parsed.password) throw new Error("FABRIC_CDP_RELAY_URL must not contain credentials");
  return parsed.toString();
}

function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) return Promise.reject(new Error("CDP relay socket is closed"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("CDP relay socket did not open before the deadline")); }, timeoutMs);
    const onOpen = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("CDP relay socket failed to open")); };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

export class OutboundCdpRelay {
  readonly #options: CdpRelayOptions;
  #gateway: WebSocket | undefined;
  #browser: WebSocket | undefined;
  #closed = false;

  public constructor(options: CdpRelayOptions) {
    this.#options = options;
  }

  public async start(): Promise<void> {
    if (this.#gateway || this.#browser) throw new Error("CDP relay is already started");
    const timeoutMs = this.#options.openTimeoutMs ?? 15_000;
    const factory = this.#options.socketFactory ?? ((url, options) => new WebSocket(url, options as any));
    const gatewayUrl = replaceTemplate(this.#options.gatewayUrl, this.#options.workerId, this.#options.leaseId);
    const socketOptions = {
      headers: {
        "x-fabric-mtls-verified": "true",
        "x-fabric-worker-cert-fingerprint": this.#options.headers?.["x-fabric-worker-cert-fingerprint"] ?? "",
        // The gateway's outer mTLS verifier uses the generic principal fingerprint header;
        // reverse-relay authorization additionally verifies this same value against the
        // registered local worker. The actual TLS client certificate remains authoritative.
        "x-fabric-cert-fingerprint": this.#options.headers?.["x-fabric-cert-fingerprint"] ?? this.#options.headers?.["x-fabric-worker-cert-fingerprint"] ?? "",
        ...(this.#options.headers ?? {}),
      },
      ...(this.#options.tls === undefined ? {} : { tls: this.#options.tls }),
    };
    const browser = factory(this.#options.browserEndpoint, this.#options.tls === undefined ? undefined : { tls: this.#options.tls });
    this.#browser = browser;
    try {
      await waitForOpen(browser, timeoutMs);
      const gateway = factory(gatewayUrl, socketOptions);
      this.#gateway = gateway;
      await waitForOpen(gateway, timeoutMs);
      browser.addEventListener("message", (event) => {
        if (gateway.readyState === WebSocket.OPEN) gateway.send(event.data);
      });
      gateway.addEventListener("message", (event) => {
        if (browser.readyState === WebSocket.OPEN) browser.send(event.data);
      });
      const closeBoth = () => { void this.stop(); };
      browser.addEventListener("close", closeBoth, { once: true });
      gateway.addEventListener("close", closeBoth, { once: true });
      browser.addEventListener("error", closeBoth, { once: true });
      gateway.addEventListener("error", closeBoth, { once: true });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.#closed && !this.#gateway && !this.#browser) return;
    this.#closed = true;
    const gateway = this.#gateway;
    const browser = this.#browser;
    this.#gateway = undefined;
    this.#browser = undefined;
    try { gateway?.close(1000, "relay closed"); } catch { /* already closed */ }
    try { browser?.close(1000, "relay closed"); } catch { /* already closed */ }
  }

  public get connected(): boolean {
    return !this.#closed && this.#gateway?.readyState === WebSocket.OPEN && this.#browser?.readyState === WebSocket.OPEN;
  }
}

export function localCdpRelayOptionsFromEnvironment(input: { workerId: WorkerId; leaseId: string; browserEndpoint: string }): CdpRelayOptions | undefined {
  const gatewayUrl = process.env.FABRIC_CDP_RELAY_URL?.trim();
  if (!gatewayUrl) return undefined;
  const certificateFile = process.env.FABRIC_WORKER_CLIENT_CERT_FILE;
  const keyFile = process.env.FABRIC_WORKER_CLIENT_KEY_FILE;
  const caFile = process.env.FABRIC_WORKER_CLIENT_CA_FILE ?? process.env.FABRIC_WORKER_CA_FILE;
  const tls = certificateFile && keyFile && caFile
    ? { cert: Bun.file(certificateFile), key: Bun.file(keyFile), ca: Bun.file(caFile), rejectUnauthorized: true }
    : undefined;
  const fingerprint = process.env.FABRIC_WORKER_CERT_FINGERPRINT?.trim();
  if (!fingerprint) throw new Error("FABRIC_WORKER_CERT_FINGERPRINT is required for a local CDP relay");
  const enrollmentFile = process.env.FABRIC_WORKER_ENROLLMENT_TOKEN_FILE;
  const enrollment = enrollmentFile ? undefined : process.env.FABRIC_WORKER_ENROLLMENT_TOKEN?.trim();
  return {
    gatewayUrl,
    ...input,
    headers: { "x-fabric-worker-cert-fingerprint": fingerprint, "x-fabric-cert-fingerprint": fingerprint, ...(enrollment ? { "x-fabric-worker-enrollment": enrollment } : {}) },
    ...(tls === undefined ? {} : { tls }),
  };
}
