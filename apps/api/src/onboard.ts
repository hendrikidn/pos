import { AdminService } from './admin.service';
import { newToken, sha256 } from './auth';
import type { Database } from './db/database';

export interface OnboardOptions {
  tenantId: string;
  tenantName: string;
  outletId: string;
  outletName: string;
  /** ID pengguna pemegang token owner (dicatat di audit dan review). */
  ownerId: string;
  terminals: string[];
}

export interface OnboardResult {
  tenantCreated: boolean;
  outletCreated: boolean;
  /** Token polos, hanya tersedia sekarang; di database hanya hash-nya. */
  ownerToken: string;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

/**
 * Menyiapkan database kosong: tenant, outlet, dan token OWNER. Aman dijalankan ulang: tenant dan outlet yang sudah ada
 * dibiarkan, dan setiap pemanggilan menerbitkan token owner baru (cara memulihkan token yang hilang; token lama tetap berlaku).
 */
export async function onboard(db: Database, opts: OnboardOptions): Promise<OnboardResult> {
  for (const [label, v] of [['tenant', opts.tenantId], ['outlet', opts.outletId], ['owner', opts.ownerId], ...opts.terminals.map((t) => ['terminal', t])]) {
    if (!ID_RE.test(v!)) throw new Error(`ID ${label} "${v}" tidak valid: huruf kecil, angka, - atau _ (2–40 karakter)`);
  }
  const admin = new AdminService(db);

  const tenantCreated = !(await db.admin.query('select 1 from tenant where id = $1', [opts.tenantId])).rowCount;
  if (tenantCreated) await admin.createTenant(opts.tenantId, opts.tenantName);

  const existing = await db.admin.query<{ tenant_id: string }>('select tenant_id from outlet where id = $1', [opts.outletId]);
  if (existing.rows[0] && existing.rows[0].tenant_id !== opts.tenantId) {
    throw new Error(`outlet "${opts.outletId}" sudah dipakai tenant lain`);
  }
  const outletCreated = !existing.rowCount;
  if (outletCreated) await admin.createOutlet(opts.tenantId, opts.outletId, opts.outletName, { terminals: opts.terminals });

  const ownerToken = await admin.createApiToken(opts.tenantId, opts.ownerId, 'OWNER', 'setup');
  return { tenantCreated, outletCreated, ownerToken };
}

/**
 * Membuat admin platform pertama (atau menerbitkan ulang token bila hilang, dengan `rotate`). Hanya lewat CLI di server:
 * admin pertama tidak mungkin dibuat dari konsol karena belum ada yang boleh masuk.
 */
export async function createPlatformAdmin(db: Database, opts: { id: string; name: string; rotate?: boolean }): Promise<{ created: boolean; token: string }> {
  if (!ID_RE.test(opts.id)) throw new Error(`ID admin "${opts.id}" tidak valid: huruf kecil, angka, - atau _ (2–40 karakter)`);
  const token = newToken('adm');
  const existing = await db.admin.query('select 1 from platform_admin where id = $1', [opts.id]);
  if (existing.rowCount) {
    if (!opts.rotate) throw new Error(`admin "${opts.id}" sudah ada; tambahkan --rotate untuk menerbitkan token baru (token lama dicabut)`);
    await db.admin.query('update platform_admin set token_hash = $2, revoked_at = null where id = $1', [opts.id, sha256(token)]);
    return { created: false, token };
  }
  await db.admin.query('insert into platform_admin (id, name, token_hash) values ($1, $2, $3)', [opts.id, opts.name, sha256(token)]);
  return { created: true, token };
}
