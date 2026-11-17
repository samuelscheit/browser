import type { CdpConnection } from "@browser-fabric/worker-runtime";

/**
 * Which tabs the endpoint's in-process Turnstile guardian watches: every tab of a browser fabric
 * owns, or only the tabs fabric clients created in a browser that belongs to the user.
 */
export type GuardianScope = "all" | "agent-tabs";

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
  /** Run the Turnstile guardian over the shared connection; absent when the browser has its own. */
  readonly guardian?: GuardianScope;
  describe(): { sessionId?: string; profile?: string; detail: string };
}
