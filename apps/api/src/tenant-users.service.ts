import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiAuth } from './auth';
import { Database } from './db/database';
import { EMAIL_RE, normalizeEmail } from './login.service';

/** Peran yang boleh diundang owner. OWNER hanya dibuat oleh admin platform, agar hak tertinggi tidak bisa digandakan dari dalam tenant. */
export const INVITABLE_ROLES = ['OPS', 'MANAGER', 'SUPERVISOR'] as const;
type Invitable = (typeof INVITABLE_ROLES)[number];
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

export interface InviteInput {
  email?: unknown;
  /** ID pengguna. Samakan dengan ID staf di POS agar insiden yang melibatkan orang itu tersembunyi darinya. */
  userId?: unknown;
  role?: unknown;
}
export interface UserChange {
  email?: unknown;
  active?: unknown;
  role?: unknown;
}

function email(v: unknown): string {
  const e = normalizeEmail(v);
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new BadRequestException('format email tidak valid');
  return e;
}
function role(v: unknown): Invitable {
  if (typeof v !== 'string' || !(INVITABLE_ROLES as readonly string[]).includes(v)) {
    throw new BadRequestException(`peran harus salah satu dari: ${INVITABLE_ROLES.join(', ')}`);
  }
  return v as Invitable;
}

interface Row {
  id: number;
  user_id: string;
  email: string;
  role: string;
  active: boolean;
  created_at: string;
  last_login_at: string | null;
}

/**
 * Pengguna dashboard milik satu tenant, dikelola oleh owner. Tabelnya dilindungi RLS (app_user), sehingga satu tenant tidak bisa
 * melihat atau mengubah pengguna tenant lain bahkan jika ada kode yang lupa menyaring. Pencabutan sesi memakai koneksi pemilik
 * skema karena api_token tidak punya RLS; selalu dibatasi dengan tenant_id pemanggil.
 */
@Injectable()
export class TenantUsersService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async list(auth: ApiAuth) {
    const users = await this.db.tenantTx(auth.tenantId, async (q) =>
      (await q.query<Row>('select id::int as id, user_id, email, role, active, created_at, last_login_at from dashboard_user order by id')).rows,
    );
    const sessions = await this.db.admin.query<{ user_id: string; n: number }>(
      `select user_id, count(*)::int as n from api_token where tenant_id = $1 and session and revoked_at is null and expires_at > now() group by user_id`,
      [auth.tenantId],
    );
    const n = new Map(sessions.rows.map((r) => [r.user_id, r.n]));
    return users.map((u) => ({ ...u, active_sessions: n.get(u.user_id) ?? 0 }));
  }

  async invite(auth: ApiAuth, input: InviteInput) {
    const mail = email(input.email);
    const r = role(input.role);
    let wanted: string | null = null;
    if (input.userId !== undefined && input.userId !== '') {
      if (typeof input.userId !== 'string' || !ID_RE.test(input.userId)) throw new BadRequestException('ID pengguna hanya huruf kecil, angka, - atau _ (2–40 karakter)');
      wanted = input.userId;
    }
    // Email unik di seluruh platform; RLS hanya memperlihatkan tenant ini, jadi periksa sebagai pemilik skema.
    if ((await this.db.admin.query('select 1 from dashboard_user where lower(email) = $1', [mail])).rowCount) {
      throw new ConflictException('email sudah dipakai pengguna lain');
    }
    try {
      return await this.db.tenantTx(auth.tenantId, async (q) => {
        const taken = new Set((await q.query<{ user_id: string }>('select user_id from dashboard_user')).rows.map((x) => x.user_id));
        let userId = wanted;
        if (userId) {
          if (taken.has(userId)) throw new ConflictException(`ID pengguna "${userId}" sudah dipakai di tenant ini`);
        } else {
          const base = mail.split('@')[0]!.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
          const slug = base.length >= 2 ? base : 'user';
          userId = slug;
          for (let i = 2; taken.has(userId) && i < 50; i++) userId = `${slug}-${i}`;
        }
        const row = (
          await q.query<{ id: number }>(
            'insert into dashboard_user (tenant_id, user_id, email, role) values ($1, $2, $3, $4) returning id::int as id',
            [auth.tenantId, userId, mail, r],
          )
        ).rows[0]!;
        await q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [
          auth.tenantId, auth.userId, 'user.invite', JSON.stringify({ userId, email: mail, role: r }),
        ]);
        return { id: row.id, userId, email: mail, role: r };
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('email atau ID pengguna sudah dipakai');
      throw e;
    }
  }

  /** Mengubah email, peran, atau status. Perubahan apa pun yang memengaruhi akses memutus semua sesi pengguna itu. */
  async update(auth: ApiAuth, userRef: number, input: UserChange) {
    const newEmail = input.email === undefined ? null : email(input.email);
    const newRole = input.role === undefined ? null : role(input.role);
    if (newEmail === null && newRole === null && typeof input.active !== 'boolean') throw new BadRequestException('tidak ada yang diubah');
    if (newEmail !== null && (await this.db.admin.query('select 1 from dashboard_user where lower(email) = $1 and id <> $2', [newEmail, userRef])).rowCount) {
      throw new ConflictException('email sudah dipakai pengguna lain');
    }
    const target = await this.db.tenantTx(auth.tenantId, async (q) => {
      const u = (await q.query<Row>('select id::int as id, user_id, email, role, active, created_at, last_login_at from dashboard_user where id = $1 for update', [userRef])).rows[0];
      if (!u) throw new NotFoundException('pengguna tidak ditemukan');
      if (u.role === 'OWNER') throw new ForbiddenException('akun owner dikelola oleh administrator platform');
      const active = typeof input.active === 'boolean' ? input.active : u.active;
      await q.query('update dashboard_user set email = coalesce($2, email), role = coalesce($3, role), active = $4 where id = $1', [userRef, newEmail, newRole, active]);
      await q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [
        auth.tenantId, auth.userId, 'user.update',
        JSON.stringify({ userId: u.user_id, ...(newEmail ? { emailChanged: true } : {}), ...(newRole ? { role: newRole } : {}), active }),
      ]);
      return { userId: u.user_id, revoke: newEmail !== null || newRole !== null || !active };
    });
    if (target.revoke) {
      await this.db.admin.query('update api_token set revoked_at = now() where tenant_id = $1 and user_id = $2 and session and revoked_at is null', [auth.tenantId, target.userId]);
      await this.db.admin.query('update login_code set used_at = now() where used_at is null and user_ref = $1', [userRef]);
    }
  }
}
