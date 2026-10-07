import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { newToken, sha256, type AdminAuth } from './auth';
import { Database } from './db/database';
import type { Queryable } from './db/driver';
import { EMAIL_RE, normalizeEmail } from './login.service';
import { CLOCK, type Clock } from './pipeline.service';
import { computeKpis, dailySeries, emptyKpi, type TenantKpi } from './platform-kpi';
import { DEFAULT_SHADOW_DAYS } from './shadow';

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const MAX_TERMINALS = 50;

export interface NewTenantInput {
  tenantId?: unknown;
  tenantName?: unknown;
  outletId?: unknown;
  outletName?: unknown;
  terminals?: unknown;
  ownerId?: unknown;
  /** Email owner untuk login dengan kode. Bila diisi, token tetap tidak diterbitkan kecuali `issueToken` true. */
  ownerEmail?: unknown;
  issueToken?: unknown;
}

const ROLES = ['OWNER', 'OPS', 'MANAGER', 'SUPERVISOR'] as const;

function email(v: unknown): string {
  const e = normalizeEmail(v);
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new BadRequestException('format email tidak valid');
  return e;
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
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private audit(q: Queryable, tenantId: string, admin: AdminAuth, action: string, detail: Record<string, unknown>) {
    return q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [
      tenantId, `admin:${admin.adminId}`, action, JSON.stringify(detail),
    ]);
  }

  /** Daftar tenant beserta KPI ringkas. */
  async listTenants() {
    const now = this.clock();
    const [tenants, tokens, kpis] = await Promise.all([
      this.db.admin.query<{ id: string; name: string; created_at: string; suspended_at: string | null; suspended_reason: string | null }>(
        'select id, name, created_at, suspended_at, suspended_reason from tenant order by created_at desc, id',
      ),
      this.db.admin.query<{ tenant_id: string; n: number }>("select tenant_id, count(*)::int as n from api_token where role = 'OWNER' and revoked_at is null and not session group by tenant_id"),
      computeKpis(this.db, now),
    ]);
    const tok = new Map(tokens.rows.map((r) => [r.tenant_id, r.n]));
    return tenants.rows.map((t) => ({ ...t, owner_tokens: tok.get(t.id) ?? 0, kpi: kpis.tenants.get(t.id) ?? emptyKpi() }));
  }

  /** Ringkasan seluruh platform untuk deretan kartu KPI di halaman utama konsol. */
  async overview() {
    const list = await this.listTenants();
    const now = this.clock();
    const sum = (f: (k: TenantKpi) => number) => list.reduce((a, t) => a + f(t.kpi), 0);
    const active = list.filter((t) => !t.suspended_at);
    return {
      tenants: { total: list.length, active: active.length, suspended: list.length - active.length },
      // Tenant aktif yang tidak ada perangkat terlihat dalam 7 hari terakhir: kandidat churn atau gangguan pemasangan.
      inactive7d: active.filter((t) => t.kpi.lastActivityMs === null || now - t.kpi.lastActivityMs > 7 * 86_400_000).length,
      outlets: sum((k) => k.outlets),
      devices: { total: sum((k) => k.devicesTotal), online: sum((k) => k.devicesOnline) },
      orders7d: sum((k) => k.orders7d),
      revenue7d: sum((k) => k.revenue7d),
      incidents: { open: sum((k) => k.incidentsOpen), critical: sum((k) => k.incidentsCritical) },
    };
  }

  async getTenant(tenantId: string) {
    const now = this.clock();
    const t = (
      await this.db.admin.query('select id, name, created_at, suspended_at, suspended_reason from tenant where id = $1', [tenantId])
    ).rows[0];
    if (!t) throw new NotFoundException('tenant tidak ditemukan');
    const [outlets, devices, tokens, kpis, daily, users] = await Promise.all([
      this.db.admin.query('select id, name, terminals from outlet where tenant_id = $1 order by id', [tenantId]),
      this.db.admin.query(
        'select id, kind, outlet_id, terminal_id, last_seen_ms, revoked_at from device where tenant_id = $1 order by outlet_id, id',
        [tenantId],
      ),
      // Hanya metadata: hash dan token polos tidak pernah dikembalikan.
      this.db.admin.query(
        'select id::int as id, user_id, role, label, created_at, revoked_at from api_token where tenant_id = $1 and not session order by id desc',
        [tenantId],
      ),
      computeKpis(this.db, now, tenantId),
      dailySeries(this.db, now, tenantId),
      // Sesi login email yang masih berlaku dihitung per pengguna; isinya (token) tidak pernah dikembalikan.
      this.db.admin.query(
        `select u.id::int as id, u.user_id, u.email, u.role, u.active, u.created_at, u.last_login_at, (u.password_hash is not null) as has_password,
                (select count(*)::int from api_token s where s.tenant_id = u.tenant_id and s.user_id = u.user_id and s.session
                   and s.revoked_at is null and s.expires_at > now()) as active_sessions
         from dashboard_user u where u.tenant_id = $1 order by u.id`,
        [tenantId],
      ),
    ]);
    return {
      tenant: t,
      outlets: outlets.rows,
      devices: devices.rows,
      tokens: tokens.rows,
      users: users.rows,
      kpi: kpis.tenants.get(tenantId) ?? emptyKpi(),
      outletKpis: kpis.byOutlet.get(tenantId) ?? [],
      daily,
    };
  }

  /** Tenant baru beserta outlet pertama dan token OWNER. Satu transaksi: gagal di tengah tidak meninggalkan setengah data. */
  async createTenant(admin: AdminAuth, input: NewTenantInput) {
    const tenantId = id('ID tenant', input.tenantId);
    const tenantName = name('Nama tenant', input.tenantName);
    const outletId = id('ID outlet', input.outletId);
    const outletName = name('Nama outlet', input.outletName);
    const termIds = terminals(input.terminals);
    const ownerId = input.ownerId === undefined || input.ownerId === '' ? 'owner' : id('ID owner', input.ownerId);
    const ownerEmail = input.ownerEmail === undefined || input.ownerEmail === '' ? null : email(input.ownerEmail);
    // Dengan email owner, login memakai kode email dan token tidak perlu dibuat (bisa diminta lewat issueToken).
    const issueToken = input.issueToken === undefined ? ownerEmail === null : input.issueToken === true;

    return this.db.driver.transaction(async (q) => {
      if ((await q.query('select 1 from tenant where id = $1', [tenantId])).rowCount) throw new ConflictException(`tenant "${tenantId}" sudah ada`);
      if (ownerEmail && (await q.query('select 1 from dashboard_user where lower(email) = $1', [ownerEmail])).rowCount) throw new ConflictException('email sudah dipakai pengguna lain');
      if ((await q.query('select 1 from outlet where id = $1', [outletId])).rowCount) throw new ConflictException(`outlet "${outletId}" sudah dipakai`);
      await q.query('insert into tenant (id, name) values ($1, $2)', [tenantId, tenantName]);
      await q.query('insert into outlet (id, tenant_id, name, terminals, shadow_days) values ($1, $2, $3, $4::jsonb, $5)', [
        outletId, tenantId, outletName, JSON.stringify(termIds), DEFAULT_SHADOW_DAYS,
      ]);
      let ownerToken: string | undefined;
      if (issueToken) {
        ownerToken = newToken('api');
        await q.query("insert into api_token (token_hash, tenant_id, user_id, role, label) values ($1, $2, $3, 'OWNER', $4)", [
          sha256(ownerToken), tenantId, ownerId, 'token awal (dibuat admin)',
        ]);
      }
      if (ownerEmail) await q.query("insert into dashboard_user (tenant_id, user_id, email, role) values ($1, $2, $3, 'OWNER')", [tenantId, ownerId, ownerEmail]);
      await this.audit(q, tenantId, admin, 'platform.tenant.create', { tenantId, tenantName, outletId, ownerId, ownerEmail, tokenIssued: issueToken });
      return { tenantId, outletId, ownerId, ownerEmail, ownerToken };
    });
  }

  async renameTenant(admin: AdminAuth, tenantId: string, nameInput: unknown) {
    const newName = name('Nama tenant', nameInput);
    await this.db.driver.transaction(async (q) => {
      const before = (await q.query<{ name: string }>('select name from tenant where id = $1 for update', [tenantId])).rows[0];
      if (!before) throw new NotFoundException('tenant tidak ditemukan');
      await q.query('update tenant set name = $2 where id = $1', [tenantId, newName]);
      await this.audit(q, tenantId, admin, 'platform.tenant.rename', { from: before.name, to: newName });
    });
  }

  /**
   * Menangguhkan tenant: semua token pengguna dan perangkatnya langsung ditolak (403), tanpa menghapus data atau token.
   * Mengaktifkan kembali memulihkan semuanya apa adanya.
   */
  async setSuspended(admin: AdminAuth, tenantId: string, suspended: boolean, reasonInput?: unknown) {
    const reason = typeof reasonInput === 'string' && reasonInput.trim() ? reasonInput.trim().slice(0, 200) : null;
    await this.db.driver.transaction(async (q) => {
      const cur = (await q.query<{ suspended_at: string | null }>('select suspended_at from tenant where id = $1 for update', [tenantId])).rows[0];
      if (!cur) throw new NotFoundException('tenant tidak ditemukan');
      if (suspended === (cur.suspended_at !== null)) throw new ConflictException(suspended ? 'tenant sudah ditangguhkan' : 'tenant sudah aktif');
      await q.query('update tenant set suspended_at = case when $2::boolean then now() else null end, suspended_reason = $3 where id = $1', [
        tenantId, suspended, suspended ? reason : null,
      ]);
      await this.audit(q, tenantId, admin, suspended ? 'platform.tenant.suspend' : 'platform.tenant.reactivate', suspended ? { reason } : {});
    });
  }

  /** Menambah pengguna dashboard (login dengan kode email). userId dibuat dari email bila tidak diberikan. */
  async addUser(admin: AdminAuth, tenantId: string, input: { email?: unknown; userId?: unknown; role?: unknown }) {
    const mail = email(input.email);
    const role = input.role === undefined ? 'OWNER' : String(input.role);
    if (!(ROLES as readonly string[]).includes(role)) throw new BadRequestException(`peran harus salah satu dari: ${ROLES.join(', ')}`);
    const slug = mail.split('@')[0]!.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    const userId = input.userId === undefined || input.userId === '' ? id('ID pengguna', slug.length >= 2 ? slug : 'user') : id('ID pengguna', input.userId);
    return this.db.driver.transaction(async (q) => {
      if (!(await q.query('select 1 from tenant where id = $1', [tenantId])).rowCount) throw new NotFoundException('tenant tidak ditemukan');
      if ((await q.query('select 1 from dashboard_user where lower(email) = $1', [mail])).rowCount) throw new ConflictException('email sudah dipakai pengguna lain');
      if ((await q.query('select 1 from dashboard_user where tenant_id = $1 and user_id = $2', [tenantId, userId])).rowCount) throw new ConflictException(`ID pengguna "${userId}" sudah dipakai di tenant ini`);
      const row = (await q.query<{ id: number }>('insert into dashboard_user (tenant_id, user_id, email, role) values ($1, $2, $3, $4) returning id::int as id', [tenantId, userId, mail, role])).rows[0]!;
      await this.audit(q, tenantId, admin, 'platform.user.add', { userId, email: mail, role });
      return { id: row.id, userId, email: mail, role };
    });
  }

  /**
   * Mengganti email atau menonaktifkan/mengaktifkan pengguna. Mengganti email atau menonaktifkan mencabut semua sesi pengguna itu,
   * sehingga akses lama (misalnya email yang jatuh ke orang lain) langsung putus.
   */
  async updateUser(admin: AdminAuth, tenantId: string, userRef: number, input: { email?: unknown; active?: unknown }) {
    const newEmail = input.email === undefined ? null : email(input.email);
    if (newEmail === null && typeof input.active !== 'boolean') throw new BadRequestException('tidak ada yang diubah');
    await this.db.driver.transaction(async (q) => {
      const u = (await q.query<{ user_id: string; email: string; active: boolean }>('select user_id, email, active from dashboard_user where id = $1 and tenant_id = $2 for update', [userRef, tenantId])).rows[0];
      if (!u) throw new NotFoundException('pengguna tidak ditemukan');
      if (newEmail !== null && newEmail !== u.email.toLowerCase() && (await q.query('select 1 from dashboard_user where lower(email) = $1 and id <> $2', [newEmail, userRef])).rowCount) {
        throw new ConflictException('email sudah dipakai pengguna lain');
      }
      const active = typeof input.active === 'boolean' ? input.active : u.active;
      await q.query('update dashboard_user set email = coalesce($2, email), active = $3 where id = $1', [userRef, newEmail, active]);
      // Pemilik email baru tidak boleh mewarisi password lama: ia mengatur sendiri lewat "Lupa password".
      if (newEmail !== null && newEmail !== u.email.toLowerCase()) await q.query('update dashboard_user set password_hash = null, password_set_at = null, failed_logins = 0, locked_until = null where id = $1', [userRef]);
      if (newEmail !== null || !active) {
        await q.query('update api_token set revoked_at = now() where tenant_id = $1 and user_id = $2 and session and revoked_at is null', [tenantId, u.user_id]);
        // Kode yang sudah terkirim ke email lama tidak boleh bisa dipakai lagi.
        await q.query('update login_code set used_at = now() where user_ref = $1 and used_at is null', [userRef]);
      }
      await this.audit(q, tenantId, admin, 'platform.user.update', { userId: u.user_id, ...(newEmail !== null ? { emailChanged: true } : {}), active });
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
