import { AdminService } from './admin.service';
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
