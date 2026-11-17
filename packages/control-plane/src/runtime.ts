import { DEFAULT_ACTIVE_BROWSER_LEASES, MAX_ACTIVE_BROWSER_LEASES } from "@browser-fabric/contracts";
import { Pool } from "pg";
import { CapabilitySigner } from "./capability";
import { BrowserScheduler } from "./scheduler";
import { PgSqlClient } from "./postgres-client";
import { PostgresFabricStore } from "./store";
import { loadPostgresMigrations } from "./migrations";
import type { EphemeralInputVault } from "./ephemeral";
import { loadFabricCatalog, type FabricCatalog } from "./catalog";

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
  /** The deployment's catalog; defaults to the file named by FABRIC_CATALOG_FILE (none: built-ins only). */
  catalog?: FabricCatalog;
}

/**
 * Parse the process-wide deployment cap once at the scheduler-runtime boundary so API replicas,
 * workers, gateways, and the standalone scheduler cannot quietly use different capacities.
 */
export function maxActiveBrowserLeasesFromEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env): number {
  const configured = environment.FABRIC_MAX_ACTIVE_BROWSER_LEASES?.trim();
  if (configured === undefined || configured === "") return DEFAULT_ACTIVE_BROWSER_LEASES;
  const value = Number(configured);
  if (!/^\d+$/.test(configured) || value < 1 || value > MAX_ACTIVE_BROWSER_LEASES) {
    throw new Error(`FABRIC_MAX_ACTIVE_BROWSER_LEASES must be an integer from 1 to ${MAX_ACTIVE_BROWSER_LEASES}`);
  }
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
  // Parse the catalog before touching the database so a broken catalog never half-starts a process.
  const catalog = options.catalog ?? await loadFabricCatalog();
  const pool = new Pool({ connectionString: options.databaseUrl, max: options.poolSize ?? 10, ssl: options.ssl ? { rejectUnauthorized: true } : undefined });
  const directory = options.schemaDirectory ?? new URL("../../../deploy/postgres/", import.meta.url);
  const schema = await loadPostgresMigrations(directory);
  const store = new PostgresFabricStore(PgSqlClient.fromPool(pool), schema);
  await store.initialize();
  const scheduler = new BrowserScheduler({
    store,
    capabilitySigner: new CapabilitySigner({ secret: options.capabilitySecret, gatewayBaseUrl: options.gatewayBaseUrl }),
    maxActiveBrowserLeases: options.maxActiveBrowserLeases ?? maxActiveBrowserLeasesFromEnvironment(),
    catalog,
    ...(options.ephemeralInputVault === undefined ? {} : { ephemeralInputVault: options.ephemeralInputVault })
  });
  await scheduler.bootstrap();
  return { scheduler, pool, close: async () => pool.end() };
}
