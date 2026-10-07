import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Driver, Queryable } from './driver';

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

export class Database {
  constructor(readonly driver: Driver) {}

  /** Akses pemilik skema (melewati RLS). Hanya untuk autentikasi token dan administrasi. */
  get admin(): Queryable {
    return this.driver;
  }

  /**
   * Transaksi atas nama satu tenant: berjalan sebagai role `app_user` dengan `app.tenant_id` terisi,
   * sehingga RLS membatasi semua query ke tenant itu bahkan jika kode lupa menyaring.
   */
  tenantTx<T>(tenantId: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.driver.transaction(async (q) => {
      await q.query('set local role app_user');
      await q.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      return fn(q);
    });
  }

  async migrate(): Promise<string[]> {
    await this.driver.exec(
      'create table if not exists schema_migration (name text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set(
      (await this.driver.query<{ name: string }>('select name from schema_migration')).rows.map((r) => r.name),
    );
    const applied: string[] = [];
    const files = readdirSync(fileURLToPath(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
      await this.driver.exec(sql);
      await this.driver.query('insert into schema_migration (name) values ($1)', [file]);
      applied.push(file);
    }
    return applied;
  }

  close(): Promise<void> {
    return this.driver.close();
  }
}
