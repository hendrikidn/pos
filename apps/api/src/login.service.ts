import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { newToken, sha256, SUSPENDED_MESSAGE, type ApiAuth, type ApiRole } from './auth';
import { Database } from './db/database';
import type { Queryable } from './db/driver';
import { MAILER, type Mailer } from './mailer';
import { burnVerify, checkPassword, hashPassword, PASSWORD_MAX, verifyPassword } from './password';
import { CLOCK, type Clock } from './pipeline.service';
import { RateLimiter } from './rate-limit';

export const CODE_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 7 * 24 * 3600_000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60_000;
const MAX_CODES_PER_HOUR = 5;
/** Akun dikunci 15 menit setelah 5 password salah berturut-turut. Kode email tetap bisa dipakai untuk masuk atau mengatur ulang. */
export const LOCK_AFTER = 5;
export const LOCK_MS = 15 * 60_000;
/** Per alamat pemanggil: batas permintaan kode dan percobaan salah dalam jendela 15 menit. */
const IP_WINDOW_MS = 15 * 60_000;
const IP_MAX_REQUESTS = 20;
const IP_MAX_FAILS = 20;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normalizeEmail = (raw: unknown): string => (typeof raw === 'string' ? raw.trim().toLowerCase() : '');

type Purpose = 'login' | 'reset';
const hashCode = (salt: string, code: string) => createHash('sha256').update(`${salt}:${code}`).digest('hex');
const GENERIC_LOGIN_ERROR = 'email atau password salah';
const GENERIC_CODE_ERROR = 'kode salah atau sudah kedaluwarsa';

export interface LoginResult {
  token: string;
  userId: string;
  role: ApiRole;
  tenantId: string;
  expiresAt: string;
}

interface UserRow {
  id: number;
  tenant_id: string;
  user_id: string;
  role: ApiRole;
  email: string;
  active: boolean;
  suspended: boolean;
  password_hash: string | null;
  locked: boolean;
}

const USER_SELECT = `
  select u.id::int as id, u.tenant_id, u.user_id, u.role, u.email, u.active, u.password_hash,
         t.suspended_at is not null as suspended,
         (u.locked_until is not null and u.locked_until > to_timestamp($2::float8 / 1000.0)) as locked
  from dashboard_user u join tenant t on t.id = u.tenant_id`;

/**
 * Login dashboard: email + password sebagai cara utama; kode email 6 digit untuk mengatur atau mengatur ulang password dan sebagai
 * jalur alternatif. Setelah berhasil, server menerbitkan sesi (baris api_token yang kedaluwarsa) yang dipakai dashboard persis seperti
 * token biasa. Semua kegagalan memakai pesan yang sama dan waktu respons yang sama, ada atau tidaknya emailnya, agar daftar email
 * pengguna tidak bisa ditebak.
 */
@Injectable()
export class LoginService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  // ---------- pembatas per alamat ----------

  /** Mencatat satu kegagalan dari alamat ini (jendela IP_WINDOW_MS). */
  private recordFail(caller: string, now: number): Promise<unknown> {
    return this.limiter.hit(`login:fail:${caller}`, IP_WINDOW_MS, now);
  }

  private assertNotThrottled(caller: string, now: number): Promise<void> {
    return this.limiter.assertBelow(`login:fail:${caller}`, IP_MAX_FAILS, now, 'terlalu banyak percobaan; coba lagi nanti');
  }

  private async lookup(q: Queryable, emailLower: string, now: number): Promise<UserRow | undefined> {
    return (await q.query<UserRow>(`${USER_SELECT} where lower(u.email) = $1`, [emailLower, now])).rows[0];
  }

  // ---------- kode email ----------

  /** Mengirim kode ke email bila terdaftar dan aktif. Selalu berhasil dari sudut pandang pemanggil. */
  async requestCode(emailRaw: unknown, caller: string, purpose: Purpose = 'login'): Promise<void> {
    const now = this.clock();
    const email = normalizeEmail(emailRaw);
    if (email.length > 254 || !EMAIL_RE.test(email)) throw new BadRequestException('format email tidak valid');
    if ((await this.limiter.hit(`login:req:${caller}`, IP_WINDOW_MS, now)).count > IP_MAX_REQUESTS) {
      throw new HttpException('terlalu banyak permintaan; coba lagi nanti', HttpStatus.TOO_MANY_REQUESTS);
    }

    const user = (await this.db.admin.query<{ id: number }>('select id::int as id from dashboard_user where lower(email) = $1 and active', [email])).rows[0];
    if (!user) return; // diam-diam: tidak membocorkan apakah email terdaftar

    // Batas pengiriman dihitung gabungan semua jenis kode, agar tidak bisa dipakai membanjiri kotak masuk.
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
      // Hanya kode terbaru dari jenis yang sama yang berlaku.
      await q.query("update login_code set used_at = to_timestamp($2::float8 / 1000.0) where user_ref = $1 and purpose = $3 and used_at is null", [user.id, now, purpose]);
      await q.query(
        `insert into login_code (user_ref, code_hash, salt, purpose, created_at, expires_at)
         values ($1, $2, $3, $4, to_timestamp($5::float8 / 1000.0), to_timestamp($6::float8 / 1000.0))`,
        [user.id, hashCode(salt, code), salt, purpose, now, now + CODE_TTL_MS],
      );
    });

    const minutes = CODE_TTL_MS / 60_000;
    const mail =
      purpose === 'reset'
        ? {
            subject: `Kode atur ulang password Anatta POS: ${code}`,
            text: `Kode untuk mengatur atau mengatur ulang password Anatta POS Anda: ${code}\n\nBerlaku ${minutes} menit dan hanya bisa dipakai sekali.\nJika Anda tidak memintanya, abaikan email ini; password Anda tidak berubah.`,
            html: `<p>Kode untuk mengatur atau mengatur ulang password Anatta POS Anda:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:8px 0">${code}</p><p>Berlaku ${minutes} menit dan hanya bisa dipakai sekali.</p><p style="color:#666">Jika Anda tidak memintanya, abaikan email ini; password Anda tidak berubah.</p>`,
          }
        : {
            subject: `Kode masuk Anatta POS: ${code}`,
            text: `Kode masuk Anatta POS Anda: ${code}\n\nBerlaku ${minutes} menit dan hanya bisa dipakai sekali.\nJika Anda tidak meminta kode ini, abaikan email ini; akun Anda tetap aman.`,
            html: `<p>Kode masuk Anatta POS Anda:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:8px 0">${code}</p><p>Berlaku ${minutes} menit dan hanya bisa dipakai sekali.</p><p style="color:#666">Jika Anda tidak meminta kode ini, abaikan email ini; akun Anda tetap aman.</p>`,
          };
    try {
      await this.mailer.send({ to: email, ...mail });
    } catch (e) {
      // Kegagalan pengiriman tidak boleh terlihat oleh pemanggil (akan membocorkan email terdaftar); catat di log server.
      console.error(`[mail] gagal mengirim kode: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Memakai kode terbaru bila cocok. Kode salah dihitung, dan setelah 5 kali salah kode itu mati. Mengembalikan false tanpa melempar
   * agar penghitung percobaan tetap tersimpan (melempar di dalam transaksi akan membatalkannya).
   */
  private async consumeCode(q: Queryable, userRef: number, code: string, purpose: Purpose, now: number): Promise<boolean> {
    const row = (
      await q.query<{ id: number; code_hash: string; salt: string; attempts: number }>(
        `select id::int as id, code_hash, salt, attempts from login_code
         where user_ref = $1 and purpose = $3 and used_at is null and expires_at > to_timestamp($2::float8 / 1000.0)
         order by id desc limit 1 for update`,
        [userRef, now, purpose],
      )
    ).rows[0];
    if (!row || row.attempts >= MAX_ATTEMPTS) return false;
    const good = timingSafeEqual(Buffer.from(hashCode(row.salt, code), 'hex'), Buffer.from(row.code_hash, 'hex'));
    if (!good) {
      await q.query('update login_code set attempts = attempts + 1 where id = $1', [row.id]);
      return false;
    }
    await q.query('update login_code set used_at = to_timestamp($2::float8 / 1000.0) where id = $1', [row.id, now]);
    return true;
  }

  private async createSession(q: Queryable, u: UserRow, now: number, method: string): Promise<LoginResult> {
    const token = newToken('api');
    const expiresAt = now + SESSION_TTL_MS;
    await q.query(
      `insert into api_token (token_hash, tenant_id, user_id, role, label, expires_at, session)
       values ($1, $2, $3, $4, 'sesi email', to_timestamp($5::float8 / 1000.0), true)`,
      [sha256(token), u.tenant_id, u.user_id, u.role, expiresAt],
    );
    await q.query('update dashboard_user set last_login_at = to_timestamp($2::float8 / 1000.0), failed_logins = 0, locked_until = null where id = $1', [u.id, now]);
    // Sesi yang sudah lama kedaluwarsa dibersihkan sambil lalu.
    await q.query('delete from api_token where session and expires_at < to_timestamp(($1::float8 - 86400000) / 1000.0)', [now]);
    await q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [u.tenant_id, u.user_id, 'auth.login', JSON.stringify({ method })]);
    return { token, userId: u.user_id, role: u.role, tenantId: u.tenant_id, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Masuk dengan kode email (jalur alternatif tanpa password). */
  async verifyCode(emailRaw: unknown, codeRaw: unknown, caller: string): Promise<LoginResult> {
    const now = this.clock();
    await this.assertNotThrottled(caller, now);
    const email = normalizeEmail(emailRaw);
    const code = typeof codeRaw === 'string' ? codeRaw.replace(/\s+/g, '') : '';
    const fail = async (): Promise<never> => {
      await this.recordFail(caller, now);
      throw new BadRequestException(GENERIC_CODE_ERROR);
    };
    if (!EMAIL_RE.test(email) || !/^[0-9]{6}$/.test(code)) return fail();

    const outcome = await this.db.driver.transaction(async (q) => {
      const user = await this.lookup(q, email, now);
      if (!user || !user.active) return { ok: false as const };
      if (!(await this.consumeCode(q, user.id, code, 'login', now))) return { ok: false as const };
      if (user.suspended) return { ok: false as const, suspended: true as const };
      return { ok: true as const, result: await this.createSession(q, user, now, 'email_code') };
    });
    if (!outcome.ok) {
      if ('suspended' in outcome) throw new ForbiddenException(SUSPENDED_MESSAGE);
      return fail();
    }
    return outcome.result;
  }

  // ---------- password ----------

  /** Masuk dengan email dan password. Gagal dengan pesan dan waktu yang sama untuk email tak dikenal, nonaktif, atau belum punya password. */
  async login(emailRaw: unknown, passwordRaw: unknown, caller: string): Promise<LoginResult> {
    const now = this.clock();
    await this.assertNotThrottled(caller, now);
    const email = normalizeEmail(emailRaw);
    const password = typeof passwordRaw === 'string' ? passwordRaw.slice(0, PASSWORD_MAX + 1) : '';
    const fail = async (): Promise<never> => {
      await this.recordFail(caller, now);
      throw new BadRequestException(GENERIC_LOGIN_ERROR);
    };

    const user = EMAIL_RE.test(email) && password ? await this.lookup(this.db.admin, email, now) : undefined;
    if (!user || !user.active || !user.password_hash || password.length > PASSWORD_MAX) {
      await burnVerify(password); // samakan waktu respons dengan jalur yang memverifikasi sungguhan
      return fail();
    }
    if (user.locked) {
      await burnVerify(password);
      throw new HttpException('terlalu banyak percobaan gagal untuk akun ini; coba lagi dalam 15 menit, atau atur ulang password lewat email', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      await this.recordFailedPassword(user.id, now);
      return fail();
    }
    if (user.suspended) throw new ForbiddenException(SUSPENDED_MESSAGE);
    return this.db.driver.transaction((q) => this.createSession(q, user, now, 'password'));
  }

  private async recordFailedPassword(userRef: number, now: number): Promise<void> {
    await this.db.admin.query(
      `update dashboard_user set
         failed_logins = case when failed_logins + 1 >= $2 then 0 else failed_logins + 1 end,
         locked_until = case when failed_logins + 1 >= $2 then to_timestamp($3::float8 / 1000.0) else locked_until end
       where id = $1`,
      [userRef, LOCK_AFTER, now + LOCK_MS],
    );
  }

  /**
   * Mengatur atau mengatur ulang password dengan kode dari email, lalu langsung masuk. Semua sesi lama pengguna itu diputus, dan
   * penguncian akun dibuka. Kode hanya dipakai bila password lolos pemeriksaan, supaya salah ketik tidak menghanguskannya.
   */
  async resetPassword(emailRaw: unknown, codeRaw: unknown, passwordRaw: unknown, caller: string): Promise<LoginResult> {
    const now = this.clock();
    await this.assertNotThrottled(caller, now);
    const email = normalizeEmail(emailRaw);
    const code = typeof codeRaw === 'string' ? codeRaw.replace(/\s+/g, '') : '';
    const fail = async (): Promise<never> => {
      await this.recordFail(caller, now);
      throw new BadRequestException(GENERIC_CODE_ERROR);
    };
    if (!EMAIL_RE.test(email) || !/^[0-9]{6}$/.test(code)) return fail();
    const password = checkPassword(passwordRaw, email);
    // Hash dihitung sebelum mencari pengguna: waktu respons sama untuk email terdaftar maupun tidak.
    const hash = await hashPassword(password);

    const outcome = await this.db.driver.transaction(async (q) => {
      const user = await this.lookup(q, email, now);
      if (!user || !user.active) return { ok: false as const };
      if (!(await this.consumeCode(q, user.id, code, 'reset', now))) return { ok: false as const };
      if (user.suspended) return { ok: false as const, suspended: true as const };
      await q.query(
        'update dashboard_user set password_hash = $2, password_set_at = to_timestamp($3::float8 / 1000.0), failed_logins = 0, locked_until = null where id = $1',
        [user.id, hash, now],
      );
      await q.query('update api_token set revoked_at = now() where tenant_id = $1 and user_id = $2 and session and revoked_at is null', [user.tenant_id, user.user_id]);
      await q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [user.tenant_id, user.user_id, 'auth.password.reset', '{}']);
      return { ok: true as const, result: await this.createSession(q, user, now, 'password_reset') };
    });
    if (!outcome.ok) {
      if ('suspended' in outcome) throw new ForbiddenException(SUSPENDED_MESSAGE);
      return fail();
    }
    return outcome.result;
  }

  /** Mengganti password dari dalam sesi. Perlu password lama; sesi lain pengguna itu diputus, sesi ini tetap. */
  async changePassword(auth: ApiAuth, currentToken: string, currentRaw: unknown, nextRaw: unknown, caller: string): Promise<void> {
    const now = this.clock();
    await this.assertNotThrottled(caller, now);
    const user = (
      await this.db.admin.query<UserRow>(`${USER_SELECT} where u.tenant_id = $1 and u.user_id = $3`, [auth.tenantId, now, auth.userId])
    ).rows[0];
    if (!user || !user.password_hash) throw new BadRequestException('akun ini belum memakai password; atur lewat "Lupa password" di halaman masuk');
    if (user.locked) throw new HttpException('terlalu banyak percobaan gagal; coba lagi dalam 15 menit', HttpStatus.TOO_MANY_REQUESTS);

    const current = typeof currentRaw === 'string' ? currentRaw.slice(0, PASSWORD_MAX + 1) : '';
    if (!current || current.length > PASSWORD_MAX || !(await verifyPassword(current, user.password_hash))) {
      await this.recordFailedPassword(user.id, now);
      await this.recordFail(caller, now);
      throw new BadRequestException('password saat ini salah');
    }
    const next = checkPassword(nextRaw, user.email);
    if (next === current) throw new BadRequestException('password baru harus berbeda dari yang lama');
    const hash = await hashPassword(next);
    await this.db.driver.transaction(async (q) => {
      await q.query('update dashboard_user set password_hash = $2, password_set_at = to_timestamp($3::float8 / 1000.0), failed_logins = 0, locked_until = null where id = $1', [user.id, hash, now]);
      await q.query(
        'update api_token set revoked_at = now() where tenant_id = $1 and user_id = $2 and session and revoked_at is null and token_hash <> $3',
        [auth.tenantId, auth.userId, sha256(currentToken)],
      );
      await q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [auth.tenantId, auth.userId, 'auth.password.change', '{}']);
    });
  }

  /** Keluar: hanya sesi login yang dicabut. Token tetap yang diterbitkan admin tidak ikut mati. */
  async logout(token: string, tenantId: string, userId: string): Promise<void> {
    const r = await this.db.admin.query('update api_token set revoked_at = now() where token_hash = $1 and session and revoked_at is null', [sha256(token)]);
    if (r.rowCount) {
      await this.db.admin.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [tenantId, userId, 'auth.logout', '{}']);
    }
  }
}
