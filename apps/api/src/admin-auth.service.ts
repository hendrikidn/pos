import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { newToken, sha256, type AdminAuth } from './auth';
import { Database } from './db/database';
import { normalizeIp, parseAllowList } from './ip-allow';
import { CLOCK, type Clock } from './pipeline.service';
import { RateLimiter } from './rate-limit';
import { open, otpauthUrl, newTotpSecret, seal, verifyTotp } from './totp';

const SESSION_TTL_MS = 12 * 3_600_000;
const LOGIN_PER_IP = 20;
const LOGIN_WINDOW_MS = 15 * 60_000;
const FAILS_PER_ADMIN = 5;
const RECOVERY_CODES = 8;
const recoveryHash = (code: string) => createHash('sha256').update(code.replace(/[\s-]/g, '').toLowerCase()).digest('hex');

interface AdminRow { id: string; totp_secret: string | null; totp_pending: string | null; totp_enabled: boolean; totp_last_step: string }

/**
 * Login konsol admin dengan verifikasi 2 langkah. Token admin (`adm_`) yang panjang-umur ditukar dengan SESI berumur 12 jam (disimpan sebagai hash,
 * bisa dicabut). Bila 2FA aktif untuk admin itu, token mentah TIDAK lagi diterima langsung oleh API: harus lewat login + kode TOTP (atau kode
 * pemulihan sekali pakai). Percobaan salah dibatasi per alamat dan per admin; kode TOTP yang sama tidak bisa dipakai dua kali.
 */
@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  private audit(actor: string, action: string, detail: object = {}) {
    // Tabel audit_log milik tenant; tindakan admin platform dicatat di sini dengan tenant kosong tidak mungkin, jadi dicatat di log aplikasi.
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'admin', actor, action, ...detail })}\n`);
  }

  private async admin(id: string): Promise<AdminRow> {
    const a = (await this.db.admin.query<AdminRow>('select id, totp_secret, totp_pending, totp_enabled, totp_last_step from platform_admin where id = $1 and revoked_at is null', [id])).rows[0];
    if (!a) throw new UnauthorizedException('admin tidak dikenal');
    return a;
  }

  /** Memeriksa kode TOTP (dan mencatat langkahnya secara atomik) atau kode pemulihan. */
  private async checkSecondFactor(a: AdminRow, codeRaw: unknown, now: number): Promise<'totp' | 'recovery' | null> {
    const code = typeof codeRaw === 'string' ? codeRaw.trim() : '';
    if (!code) return null;
    if (/^\d{3}\s?\d{3}$/.test(code) && a.totp_secret) {
      const step = verifyTotp(open(a.totp_secret), code, now, Number(a.totp_last_step));
      if (step !== null) {
        const r = await this.db.admin.query('update platform_admin set totp_last_step = $2 where id = $1 and totp_last_step < $2', [a.id, step]);
        return r.rowCount === 1 ? 'totp' : null; // permintaan serentak dengan kode yang sama: hanya satu yang menang
      }
      return null;
    }
    if (/^[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}$/.test(code)) {
      const r = await this.db.admin.query('update admin_recovery_code set used_at = now() where admin_id = $1 and code_hash = $2 and used_at is null', [a.id, recoveryHash(code)]);
      return r.rowCount === 1 ? 'recovery' : null;
    }
    return null;
  }

  async login(body: { token?: unknown; code?: unknown }, caller: string, userAgent: string | undefined) {
    const now = this.clock();
    const allow = parseAllowList(process.env['ADMIN_ALLOWED_IPS']);
    if (!allow.test(caller)) {
      this.audit('?', 'login.denied_ip', { ip: caller });
      throw new ForbiddenException('akses konsol admin tidak diizinkan dari alamat ini');
    }
    await this.limiter.enforce(`adm:login:ip:${caller}`, LOGIN_PER_IP, LOGIN_WINDOW_MS, now, 'terlalu banyak percobaan login; coba lagi nanti');
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const row = token.startsWith('adm_')
      ? (await this.db.admin.query<{ id: string }>('select id from platform_admin where token_hash = $1 and revoked_at is null', [sha256(token)])).rows[0]
      : undefined;
    if (!row) throw new UnauthorizedException('token admin tidak dikenal');
    const a = await this.admin(row.id);
    if (a.totp_enabled) {
      await this.limiter.assertBelow(`adm:2fa:${a.id}`, FAILS_PER_ADMIN, now, 'terlalu banyak kode salah; coba lagi dalam 15 menit');
      if (typeof body.code !== 'string' || !body.code.trim()) throw new UnauthorizedException({ message: 'masukkan kode verifikasi 2 langkah', needs2fa: true });
      const used = await this.checkSecondFactor(a, body.code, now);
      if (!used) {
        await this.limiter.hit(`adm:2fa:${a.id}`, LOGIN_WINDOW_MS, now);
        this.audit(a.id, 'login.bad_code', { ip: caller });
        throw new UnauthorizedException({ message: 'kode verifikasi salah atau sudah dipakai', needs2fa: true });
      }
      if (used === 'recovery') this.audit(a.id, 'login.recovery_code_used', { ip: caller });
    }
    const session = newToken('adm');
    const expires = now + SESSION_TTL_MS;
    await this.db.admin.query('insert into admin_session (token_hash, admin_id, expires_at, ip, user_agent) values ($1, $2, to_timestamp($3::float8 / 1000.0), $4, $5)', [sha256(session), a.id, expires, normalizeIp(caller).slice(0, 64), (userAgent ?? '').slice(0, 200) || null]);
    await this.db.admin.query("delete from admin_session where expires_at < now() - interval '1 day'");
    this.audit(a.id, 'login', { ip: caller, twoFactor: a.totp_enabled });
    return { token: session, adminId: a.id, expiresAt: new Date(expires).toISOString(), twoFactor: a.totp_enabled };
  }

  async logout(sessionToken: string): Promise<void> {
    await this.db.admin.query('update admin_session set revoked_at = now() where token_hash = $1 and revoked_at is null', [sha256(sessionToken)]);
  }

  async status(auth: AdminAuth, currentToken: string) {
    const a = await this.admin(auth.adminId);
    const cur = sha256(currentToken);
    const sessions = (await this.db.admin.query<{ id: string; created_at: string; expires_at: string; ip: string | null; user_agent: string | null; token_hash: string }>(
      'select id, created_at, expires_at, ip, user_agent, token_hash from admin_session where admin_id = $1 and revoked_at is null and expires_at > now() order by created_at desc', [auth.adminId],
    )).rows;
    const left = Number((await this.db.admin.query<{ n: string }>('select count(*) n from admin_recovery_code where admin_id = $1 and used_at is null', [auth.adminId])).rows[0]!.n);
    return {
      adminId: a.id, twoFactor: a.totp_enabled, recoveryCodesLeft: a.totp_enabled ? left : 0,
      sessions: sessions.map((s) => ({ id: Number(s.id), createdAt: s.created_at, expiresAt: s.expires_at, ip: s.ip, userAgent: s.user_agent, current: s.token_hash === cur })),
    };
  }

  /** Langkah 1: membuat rahasia baru (belum aktif sampai kode pertama dibuktikan). */
  async setup(auth: AdminAuth) {
    const a = await this.admin(auth.adminId);
    if (a.totp_enabled) throw new BadRequestException('verifikasi 2 langkah sudah aktif; nonaktifkan dulu untuk membuat ulang');
    // Di produksi rahasia faktor kedua wajib terenkripsi: tanpa SECRETS_KEY bocornya basis data membocorkan 2FA sekaligus.
    if (!process.env['SECRETS_KEY'] && process.env['NODE_ENV'] === 'production') throw new BadRequestException('SECRETS_KEY belum diisi di server (deploy/.env); isi dengan hasil openssl rand -hex 32 lalu mulai ulang API');
    const secret = newTotpSecret();
    await this.db.admin.query('update platform_admin set totp_pending = $2 where id = $1', [a.id, seal(secret)]);
    return { secret, otpauthUrl: otpauthUrl(a.id, secret) };
  }

  /** Langkah 2: kode pertama membuktikan aplikasi autentikator sudah terpasang; barulah aktif, dan kode pemulihan diberikan SEKALI. */
  async enable(auth: AdminAuth, code: unknown) {
    const now = this.clock();
    const a = await this.admin(auth.adminId);
    if (a.totp_enabled) throw new BadRequestException('verifikasi 2 langkah sudah aktif');
    if (!a.totp_pending) throw new BadRequestException('mulai dari setup dulu');
    await this.limiter.assertBelow(`adm:2fa:${a.id}`, FAILS_PER_ADMIN, now, 'terlalu banyak kode salah; coba lagi dalam 15 menit');
    const step = verifyTotp(open(a.totp_pending), code, now, 0);
    if (step === null) {
      await this.limiter.hit(`adm:2fa:${a.id}`, LOGIN_WINDOW_MS, now);
      throw new BadRequestException('kode salah; pastikan jam ponsel akurat dan coba kode berikutnya');
    }
    const codes = Array.from({ length: RECOVERY_CODES }, () => { const h = randomBytes(6).toString('hex'); return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`; });
    await this.db.driver.transaction(async (q) => {
      await q.query('update platform_admin set totp_secret = totp_pending, totp_pending = null, totp_enabled = true, totp_last_step = $2 where id = $1', [a.id, step]);
      await q.query('delete from admin_recovery_code where admin_id = $1', [a.id]);
      for (const c of codes) await q.query('insert into admin_recovery_code (admin_id, code_hash) values ($1, $2)', [a.id, recoveryHash(c)]);
    });
    this.audit(a.id, '2fa.enabled');
    return { recoveryCodes: codes };
  }

  /** Mematikan 2FA butuh kode yang sah (TOTP atau pemulihan): pencuri sesi saja tidak bisa melepasnya. */
  async disable(auth: AdminAuth, code: unknown) {
    const now = this.clock();
    const a = await this.admin(auth.adminId);
    if (!a.totp_enabled) throw new BadRequestException('verifikasi 2 langkah belum aktif');
    await this.limiter.assertBelow(`adm:2fa:${a.id}`, FAILS_PER_ADMIN, now, 'terlalu banyak kode salah; coba lagi dalam 15 menit');
    if (!(await this.checkSecondFactor(a, code, now))) {
      await this.limiter.hit(`adm:2fa:${a.id}`, LOGIN_WINDOW_MS, now);
      throw new BadRequestException('kode salah atau sudah dipakai');
    }
    await this.db.driver.transaction(async (q) => {
      await q.query('update platform_admin set totp_secret = null, totp_pending = null, totp_enabled = false, totp_last_step = 0 where id = $1', [a.id]);
      await q.query('delete from admin_recovery_code where admin_id = $1', [a.id]);
    });
    this.audit(a.id, '2fa.disabled');
  }

  async revokeSession(auth: AdminAuth, id: number): Promise<void> {
    const r = await this.db.admin.query('update admin_session set revoked_at = now() where id = $1 and admin_id = $2 and revoked_at is null', [id, auth.adminId]);
    if (r.rowCount === 0) throw new NotFoundException('sesi tidak ditemukan');
  }

  async revokeOthers(auth: AdminAuth, currentToken: string): Promise<{ revoked: number }> {
    const r = await this.db.admin.query('update admin_session set revoked_at = now() where admin_id = $1 and revoked_at is null and token_hash <> $2', [auth.adminId, sha256(currentToken)]);
    return { revoked: r.rowCount };
  }
}

