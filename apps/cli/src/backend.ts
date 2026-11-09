/** A browser-level CDP websocket one client may open, plus the upgrade headers it needs. */
export interface UpstreamEndpoint {
  url: string;
  headers?: Readonly<Record<string, string>>;
}

/**
 * The browser behind the local endpoint. `acquire` (re)starts the browser when needed, so a
 * stable loopback URL survives remote session expiry, idle release and a crashed local Chrome.
 */
export interface BrowserBackend {
  acquire(): Promise<UpstreamEndpoint>;
  /** No client used the browser for the idle window: hand back scarce capacity. */
  suspend(): Promise<void>;
  close(): Promise<void>;
  describe(): { sessionId?: string; profile?: string; detail: string };
}
