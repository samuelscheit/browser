import { Pool } from "pg";
import { CapabilitySigner } from "./capability";
import { BrowserScheduler } from "./scheduler";
import { PgSqlClient } from "./postgres-client";
import { PostgresFabricStore } from "./store";
import { loadPostgresMigrations } from "./migrations";
import type { EphemeralInputVault } from "./ephemeral";

export interface PostgresSchedulerOptions {
  databaseUrl: string;
  capabilitySecret: string;
  gatewayBaseUrl?: string;
  poolSize?: number;
  ssl?: boolean;
  schemaDirectory?: URL;
  /** Inject a transient ciphertext broker shared by API and worker-manager processes. */
  ephemeralInputVault?: EphemeralInputVault;
  /** Explicit deployment cap for managed browser processes. Defaults to the reviewed safe maximum. */
  maxActiveBrowserLeases?: number;
}

/**
 * Parse the process-wide deployment cap once at the scheduler-runtime boundary so API replicas,
 * workers, gateways, and the standalone scheduler cannot quietly use different capacities.
 */
export function maxActiveBrowserLeasesFromEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env): number {
  const configured = environment.FABRIC_MAX_ACTIVE_BROWSER_LEASES;
  if (configured === undefined || configured.trim() === "") return 4;
  if (!/^\d+$/.test(configured.trim())) throw new Error("FABRIC_MAX_ACTIVE_BROWSER_LEASES must be an integer from one to four");
  const value = Number(configured.trim());
  if (!Number.isInteger(value) || value < 1 || value > 4) throw new Error("FABRIC_MAX_ACTIVE_BROWSER_LEASES must be an integer from one to four");
  return value;
}

export interface PostgresSchedulerRuntime {
  scheduler: BrowserScheduler;
  pool: Pool;
  close(): Promise<void>;
}

/** Shared production bootstrap used by API, gateway, and worker-manager processes. */
export async function createPostgresScheduler(options: PostgresSchedulerOptions): Promise<PostgresSchedulerRuntime> {
  if (options.capabilitySecret.length < 32) throw new Error("FABRIC_CAPABILITY_SECRET must contain at least 32 bytes");
  const pool = new Pool({ connectionString: options.databaseUrl, max: options.poolSize ?? 10, ssl: options.ssl ? { rejectUnauthorized: true } : undefined });
  const directory = options.schemaDirectory ?? new URL("../../../deploy/postgres/", import.meta.url);
  const schema = await loadPostgresMigrations(directory);
  const store = new PostgresFabricStore(PgSqlClient.fromPool(pool), schema);
  await store.initialize();
  const scheduler = new BrowserScheduler({
    store,
    capabilitySigner: new CapabilitySigner({ secret: options.capabilitySecret, gatewayBaseUrl: options.gatewayBaseUrl }),
    maxActiveBrowserLeases: options.maxActiveBrowserLeases ?? maxActiveBrowserLeasesFromEnvironment(),
    ...(options.ephemeralInputVault === undefined ? {} : { ephemeralInputVault: options.ephemeralInputVault })
  });
  await scheduler.bootstrap();
  return { scheduler, pool, close: async () => pool.end() };
}
