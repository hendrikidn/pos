import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { newToken, sha256, SUSPENDED_MESSAGE, type ApiRole } from './auth';
import { Database } from './db/database';
import { MAILER, type Mailer } from './mailer';
import { CLOCK, type Clock } from './pipeline.service';

export const CODE_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 7 * 24 * 3600_000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60_000;
const MAX_CODES_PER_HOUR = 5;
/** Per alamat pemanggil: batas permintaan kode dan percobaan salah dalam jendela 15 menit. */
const IP_WINDOW_MS = 15 * 60_000;
const IP_MAX_REQUESTS = 20;
const IP_MAX_FAILS = 20;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normalizeEmail = (raw: unknown): string => (typeof raw === 'string' ? raw.trim().toLowerCase() : '');

const hashCode = (salt: string, code: string) => createHash('sha256').update(`${salt}:${code}`).digest('hex');

interface Bucket {
  count: number;
  resetAt: number;
}

export interface LoginResult {
  token: string;
  userId: string;
  role: ApiRole;
  tenantId: string;
  expiresAt: string;
}

/**
 * Login dengan email dan kode 6 digit sekali pakai. Setelah kode benar, server menerbitkan sesi (baris api_token yang kedaluwarsa)
 * yang dipakai dashboard persis seperti token biasa. Respons permintaan kode selalu sama, ada atau tidaknya email, agar daftar
 * email pengguna tidak bisa ditebak.
 */
@Injectable()
export class LoginService {
  private readonly requests = new Map<string, Bucket>();
  private readonly fails = new Map<string, Bucket>();

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private hit(map: Map<string, Bucket>, key: string, now: number): Bucket {
    const cur = map.get(key);
    if (!cur || cur.resetAt <= now) {
      const b = { count: 1, resetAt: now + IP_WINDOW_MS };
      map.set(key, b);
      return b;
    }
    cur.count++;
    return cur;
  }

  /** Mengirim kode ke email bila terdaftar dan aktif. Selalu berhasil dari sudut pandang pemanggil. */
  async requestCode(emailRaw: unknown, caller: string): Promise<void> {
    const now = this.clock();
    const email = normalizeEmail(emailRaw);
    if (email.length > 254 || !EMAIL_RE.test(email)) throw new BadRequestException('format email tidak valid');
    if (this.hit(this.requests, caller, now).count > IP_MAX_REQUESTS) {
      throw new HttpException('terlalu banyak permintaan; coba lagi nanti', HttpStatus.TOO_MANY_REQUESTS);
    }

    const user = (
      await this.db.admin.query<{ id: number }>('select id from dashboard_user where lower(email) = $1 and active', [email])
    ).rows[0];
    if (!user) return; // diam-diam: tidak membocorkan apakah email terdaftar

    const recent = (
      await this.db.admin.query<{ n: number; last: string | null }>(
        `select count(*)::int as n, max(extract(epoch from created_at) * 1000)::float8 as last
         from login_code where user_ref = $1 and created_at > to_timestamp(($2::float8 - 3600000) / 1000.0)`,
        [user.id, now],
      )
    ).rows[0]!;
    if (recent.n >= MAX_CODES_PER_HOUR) return;
    if (recent.last !== null && now - Number(recent.last) < RESEND_COOLDOWN_MS) return;

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    await this.db.driver.transaction(async (q) => {
      // Hanya kode terbaru yang berlaku.
      await q.query('update login_code set used_at = to_timestamp($2::float8 / 1000.0) where user_ref = $1 and used_at is null', [user.id, now]);
      await q.query(
        'insert into login_code (user_ref, code_hash, salt, created_at, expires_at) values ($1, $2, $3, to_timestamp($4::float8 / 1000.0), to_timestamp($5::float8 / 1000.0))',
        [user.id, hashCode(salt, code), salt, now, now + CODE_TTL_MS],
      );
    });

    const minutes = CODE_TTL_MS / 60_000;
    try {
      await this.mailer.send({
        to: email,
        subject: `Kode masuk POS Guard: ${code}`,
        text: `Kode masuk POS Guard Anda: ${code}\n\nBerlaku ${minutes} menit dan hanya bisa dipakai sekali.\nJika Anda tidak meminta kode ini, abaikan email ini; akun Anda tetap aman.`,
        html: `<p>Kode masuk POS Guard Anda:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:8px 0">${code}</p><p>Berlaku ${minutes} menit dan hanya bisa dipakai sekali.</p><p style="color:#666">Jika Anda tidak meminta kode ini, abaikan email ini; akun Anda tetap aman.</p>`,
      });
    } catch (e) {
      // Kegagalan pengiriman tidak boleh terlihat oleh pemanggil (akan membocorkan email terdaftar); catat di log server.
      console.error(`[mail] gagal mengirim kode login: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Menukar kode dengan sesi. Kode salah dihitung; setelah 5 kali salah kode itu mati. */
  async verifyCode(emailRaw: unknown, codeRaw: unknown, caller: string): Promise<LoginResult> {
    const now = this.clock();
    const f = this.fails.get(caller);
    if (f && f.resetAt > now && f.count >= IP_MAX_FAILS) throw new HttpException('terlalu banyak percobaan; coba lagi nanti', HttpStatus.TOO_MANY_REQUESTS);

    const email = normalizeEmail(emailRaw);
    const code = typeof codeRaw === 'string' ? codeRaw.replace(/\s+/g, '') : '';
    const fail = (): never => {
      this.hit(this.fails, caller, now);
      throw new BadRequestException('kode salah atau sudah kedaluwarsa');
    };
    if (!EMAIL_RE.test(email) || !/^[0-9]{6}$/.test(code)) return fail();

    const outcome = await this.db.driver.transaction(async (q) => {
      const user = (
        await q.query<{ id: number; tenant_id: string; user_id: string; role: ApiRole; suspended: boolean }>(
          `select u.id, u.tenant_id, u.user_id, u.role, t.suspended_at is not null as suspended
           from dashboard_user u join tenant t on t.id = u.tenant_id where lower(u.email) = $1 and u.active`,
          [email],
        )
      ).rows[0];
      if (!user) return { ok: false as const };
      const row = (
        await q.query<{ id: number; code_hash: string; salt: string; attempts: number }>(
          `select id, code_hash, salt, attempts from login_code
           where user_ref = $1 and used_at is null and expires_at > to_timestamp($2::float8 / 1000.0)
           order by id desc limit 1 for update`,
          [user.id, now],
        )
      ).rows[0];
      if (!row || row.attempts >= MAX_ATTEMPTS) return { ok: false as const };

      const good = timingSafeEqual(Buffer.from(hashCode(row.salt, code), 'hex'), Buffer.from(row.code_hash, 'hex'));
      if (!good) {
        await q.query('update login_code set attempts = attempts + 1 where id = $1', [row.id]);
        return { ok: false as const };
      }
      await q.query('update login_code set used_at = to_timestamp($2::float8 / 1000.0) where id = $1', [row.id, now]);
      if (user.suspended) return { ok: false as const, suspended: true as const };

      const token = newToken('api');
      const expiresAt = now + SESSION_TTL_MS;
      await q.query(
        `insert into api_token (token_hash, tenant_id, user_id, role, label, expires_at, session)
         values ($1, $2, $3, $4, 'sesi email', to_timestamp($5::float8 / 1000.0), true)`,
        [sha256(token), user.tenant_id, user.user_id, user.role, expiresAt],
      );
      await q.query('update dashboard_user set last_login_at = to_timestamp($2::float8 / 1000.0) where id = $1', [user.id, now]);
      // Sesi yang sudah lama kedaluwarsa dibersihkan sambil lalu.
      await q.query("delete from api_token where session and expires_at < to_timestamp(($1::float8 - 86400000) / 1000.0)", [now]);
      await q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [
        user.tenant_id, user.user_id, 'auth.login', JSON.stringify({ method: 'email_code' }),
      ]);
      return { ok: true as const, result: { token, userId: user.user_id, role: user.role, tenantId: user.tenant_id, expiresAt: new Date(expiresAt).toISOString() } };
    });

    if (!outcome.ok) {
      if ('suspended' in outcome) throw new ForbiddenException(SUSPENDED_MESSAGE);
      return fail();
    }
    return outcome.result;
  }

  /** Keluar: hanya sesi email yang dicabut. Token tetap yang diterbitkan admin tidak ikut mati. */
  async logout(token: string, tenantId: string, userId: string): Promise<void> {
    const r = await this.db.admin.query('update api_token set revoked_at = now() where token_hash = $1 and session and revoked_at is null', [sha256(token)]);
    if (r.rowCount) {
      await this.db.admin.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [tenantId, userId, 'auth.logout', '{}']);
    }
  }
}
