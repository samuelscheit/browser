import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { SqlClient } from "./store";

type PgQueryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;
type PgPool = Pick<Pool, "query" | "connect">;

/**
 * Small adapter that keeps the control plane independent from a PostgreSQL driver while ensuring
 * every control-plane transaction is pinned to one PoolClient. `pool.query("BEGIN")` is unsafe:
 * a pool can route each statement to a different connection.
 */
export class PgSqlClient implements SqlClient {
  public constructor(readonly connection: PgQueryable, private readonly pool?: PgPool) {}

  public static fromPool(pool: Pool): PgSqlClient {
    return new PgSqlClient(pool, pool);
  }

  public async query<T = unknown>(sql: string, parameters: readonly unknown[] = []): Promise<{ rows: T[] }> {
    const result = await this.connection.query(sql, parameters as unknown[]);
    return { rows: result.rows as QueryResultRow[] as T[] };
  }

  public async withTransaction<T>(operation: (transaction: SqlClient) => Promise<T>): Promise<T> {
    if (!this.pool) {
      // A scoped client is already owned by the caller. Do not start a nested transaction.
      return operation(this);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(new PgSqlClient(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  /** Run an operation on one pooled connection while holding a session advisory lock. */
  public async withAdvisoryLock<T>(key: string, operation: (client: SqlClient) => Promise<T>): Promise<T> {
    if (!this.pool) return operation(this);
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
      try {
        return await operation(new PgSqlClient(client));
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
      }
    } finally {
      client.release();
    }
  }
}
