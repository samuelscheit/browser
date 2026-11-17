import type { CdpConnection } from "@browser-fabric/worker-runtime";

/**
 * Whose browser it is. In the user's own Chrome the guardian watches only the tabs fabric clients
 * created, and no client may change what the user's default context does (downloads).
 */
export type BrowserOwner = "fabric" | "user";

/**
 * The browser behind the local endpoint. `connect` (re)starts it when needed and opens the ONE
 * browser-level connection the endpoint multiplexes every client over, so a stable loopback URL
 * survives remote session expiry, idle release and a restarted Chrome.
 */
export interface BrowserBackend {
  connect(): Promise<CdpConnection>;
  /** Present when idle capacity is scarce (remote): no client for the idle window releases the browser. */
  suspend?(): Promise<void>;
  close(): Promise<void>;
  readonly owner: BrowserOwner;
  /** Run the challenge guardian over the shared connection; false when the browser has its own (remote). */
  readonly guardian: boolean;
  describe(): { sessionId?: string; profile?: string; detail: string };
}
