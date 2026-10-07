import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { newToken, sha256, type AdminAuth } from './auth';
import { Database } from './db/database';
import type { Queryable } from './db/driver';

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const MAX_TERMINALS = 50;

export interface NewTenantInput {
  tenantId?: unknown;
  tenantName?: unknown;
  outletId?: unknown;
  outletName?: unknown;
  terminals?: unknown;
  ownerId?: unknown;
}

function id(label: string, v: unknown): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new BadRequestException(`${label} hanya huruf kecil, angka, - atau _ (2–40 karakter)`);
  return v;
}
function name(label: string, v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < 1 || s.length > 80) throw new BadRequestException(`${label} wajib diisi (maks. 80 karakter)`);
  return s;
}
function terminals(v: unknown): string[] {
  if (v === undefined || v === null || v === '') return [];
  if (!Array.isArray(v) || v.length > MAX_TERMINALS) throw new BadRequestException(`terminals harus berupa daftar (maks. ${MAX_TERMINALS})`);
  const out = v.map((t) => id('ID terminal', t));
  if (new Set(out).size !== out.length) throw new BadRequestException('ID terminal tidak boleh kembar');
  return out;
}

/** Administrasi platform: tenant, outlet, dan token owner. Berjalan sebagai pemilik skema (melewati RLS); hanya dipanggil oleh admin platform. */
@Injectable()
export class PlatformService {
  constructor(@Inject(Database) private readonly db: Database) {}

  private audit(q: Queryable, tenantId: string, admin: AdminAuth, action: string, detail: Record<string, unknown>) {
    return q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [
      tenantId, `admin:${admin.adminId}`, action, JSON.stringify(detail),
    ]);
  }

  async listTenants() {
    return (
      await this.db.admin.query(
        `select t.id, t.name, t.created_at,
                (select count(*) from outlet o where o.tenant_id = t.id)::int as outlets,
                (select count(*) from device d where d.tenant_id = t.id and d.revoked_at is null)::int as devices,
                (select max(d.last_seen_ms) from device d where d.tenant_id = t.id) as last_seen_ms,
                (select count(*) from api_token a where a.tenant_id = t.id and a.role = 'OWNER' and a.revoked_at is null)::int as owner_tokens
         from tenant t order by t.created_at desc, t.id`,
      )
    ).rows;
  }

  async getTenant(tenantId: string) {
    const t = (await this.db.admin.query('select id, name, created_at from tenant where id = $1', [tenantId])).rows[0];
    if (!t) throw new NotFoundException('tenant tidak ditemukan');
    const [outlets, devices, tokens] = await Promise.all([
      this.db.admin.query('select id, name, terminals from outlet where tenant_id = $1 order by id', [tenantId]),
      this.db.admin.query(
        'select id, kind, outlet_id, terminal_id, last_seen_ms, revoked_at from device where tenant_id = $1 order by outlet_id, id',
        [tenantId],
      ),
      // Hanya metadata: hash dan token polos tidak pernah dikembalikan.
      this.db.admin.query(
        'select id::int as id, user_id, role, label, created_at, revoked_at from api_token where tenant_id = $1 order by id desc',
        [tenantId],
      ),
    ]);
    return { tenant: t, outlets: outlets.rows, devices: devices.rows, tokens: tokens.rows };
  }

  /** Tenant baru beserta outlet pertama dan token OWNER. Satu transaksi: gagal di tengah tidak meninggalkan setengah data. */
  async createTenant(admin: AdminAuth, input: NewTenantInput) {
    const tenantId = id('ID tenant', input.tenantId);
    const tenantName = name('Nama tenant', input.tenantName);
    const outletId = id('ID outlet', input.outletId);
    const outletName = name('Nama outlet', input.outletName);
    const termIds = terminals(input.terminals);
    const ownerId = input.ownerId === undefined || input.ownerId === '' ? 'owner' : id('ID owner', input.ownerId);

    return this.db.driver.transaction(async (q) => {
      if ((await q.query('select 1 from tenant where id = $1', [tenantId])).rowCount) throw new ConflictException(`tenant "${tenantId}" sudah ada`);
      if ((await q.query('select 1 from outlet where id = $1', [outletId])).rowCount) throw new ConflictException(`outlet "${outletId}" sudah dipakai`);
      await q.query('insert into tenant (id, name) values ($1, $2)', [tenantId, tenantName]);
      await q.query('insert into outlet (id, tenant_id, name, terminals) values ($1, $2, $3, $4::jsonb)', [
        outletId, tenantId, outletName, JSON.stringify(termIds),
      ]);
      const ownerToken = newToken('api');
      await q.query("insert into api_token (token_hash, tenant_id, user_id, role, label) values ($1, $2, $3, 'OWNER', $4)", [
        sha256(ownerToken), tenantId, ownerId, 'token awal (dibuat admin)',
      ]);
      await this.audit(q, tenantId, admin, 'platform.tenant.create', { tenantId, tenantName, outletId, ownerId });
      return { tenantId, outletId, ownerId, ownerToken };
    });
  }

  async addOutlet(admin: AdminAuth, tenantId: string, input: { outletId?: unknown; outletName?: unknown; terminals?: unknown }) {
    const outletId = id('ID outlet', input.outletId);
    const outletName = name('Nama outlet', input.outletName);
    const termIds = terminals(input.terminals);
    return this.db.driver.transaction(async (q) => {
      if (!(await q.query('select 1 from tenant where id = $1', [tenantId])).rowCount) throw new NotFoundException('tenant tidak ditemukan');
      if ((await q.query('select 1 from outlet where id = $1', [outletId])).rowCount) throw new ConflictException(`outlet "${outletId}" sudah dipakai`);
      await q.query('insert into outlet (id, tenant_id, name, terminals) values ($1, $2, $3, $4::jsonb)', [
        outletId, tenantId, outletName, JSON.stringify(termIds),
      ]);
      await this.audit(q, tenantId, admin, 'platform.outlet.add', { outletId, outletName });
      return { outletId };
    });
  }

  /** Token OWNER tambahan (mis. owner kehilangan token). Token polos hanya ada di respons ini. */
  async issueOwnerToken(admin: AdminAuth, tenantId: string, input: { ownerId?: unknown; label?: unknown }) {
    const ownerId = input.ownerId === undefined || input.ownerId === '' ? 'owner' : id('ID owner', input.ownerId);
    const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 80) : 'diterbitkan admin';
    return this.db.driver.transaction(async (q) => {
      if (!(await q.query('select 1 from tenant where id = $1', [tenantId])).rowCount) throw new NotFoundException('tenant tidak ditemukan');
      const token = newToken('api');
      const row = (
        await q.query<{ id: number }>(
          "insert into api_token (token_hash, tenant_id, user_id, role, label) values ($1, $2, $3, 'OWNER', $4) returning id::int as id",
          [sha256(token), tenantId, ownerId, label],
        )
      ).rows[0]!;
      await this.audit(q, tenantId, admin, 'platform.owner_token.issue', { tokenId: row.id, ownerId, label });
      return { tokenId: row.id, ownerId, ownerToken: token };
    });
  }

  async revokeToken(admin: AdminAuth, tenantId: string, tokenId: number) {
    await this.db.driver.transaction(async (q) => {
      const r = await q.query('update api_token set revoked_at = now() where id = $1 and tenant_id = $2 and revoked_at is null', [tokenId, tenantId]);
      if (!r.rowCount) throw new NotFoundException('token tidak ditemukan atau sudah dicabut');
      await this.audit(q, tenantId, admin, 'platform.token.revoke', { tokenId });
    });
  }
}
