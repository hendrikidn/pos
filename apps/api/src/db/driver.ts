import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Driver extends Queryable {
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Menjalankan skrip multi-pernyataan (migrasi). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** PGlite melaporkan affectedRows = 0 untuk SELECT, jadi jumlah baris hasil dipakai bila tidak ada baris terdampak. */
function countOf(r: { rows: unknown[]; affectedRows?: number }): number {
  return r.affectedRows || r.rows.length;
}

/** PostgreSQL asli yang berjalan di proses (WASM). Dipakai untuk test dan demo tanpa server database. */
export class PgliteDriver implements Driver {
  private constructor(private readonly db: PGlite) {}

  static async create(): Promise<PgliteDriver> {
    const db = new PGlite();
    await db.waitReady;
    return new PgliteDriver(db);
  }

  async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const r = await this.db.query<T>(sql, params);
    return { rows: r.rows, rowCount: countOf(r) };
  }

  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) =>
      fn({
        async query<R>(sql: string, params?: unknown[]) {
          const r = await tx.query<R>(sql, params);
          return { rows: r.rows, rowCount: countOf(r) };
        },
      }),
    );
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/** PostgreSQL server (produksi). */
export class PgDriver implements Driver {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const r = await this.pool.query(sql, params as unknown[]);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
  }

  async transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await fn({
        async query<R>(sql: string, params?: unknown[]) {
          const r = await client.query(sql, params as unknown[]);
          return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length };
        },
      });
      await client.query('commit');
      return result;
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
