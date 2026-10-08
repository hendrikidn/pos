import { randomBytes } from 'node:crypto';
import { BadRequestException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { BillingService } from './billing.service';
import { Database } from './db/database';
import { EMAIL_RE, LoginService, normalizeEmail } from './login.service';
import { CLOCK, type Clock } from './pipeline.service';
import { RateLimiter } from './rate-limit';
import { DEFAULT_SHADOW_DAYS } from './shadow';

/** Pendaftaran dari satu alamat dibatasi: akun uji coba gratis tidak boleh jadi jalan membanjiri sistem. */
export const SIGNUPS_PER_IP_PER_HOUR = 3;
export const SIGNUPS_PER_HOUR_GLOBAL = 60;

const slug = (s: string, max: number): string =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');

@Injectable()
export class SignupService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(LoginService) private readonly login: LoginService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  private text(label: string, v: unknown, min: number, max: number): string {
    const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
    if (s.length < min || s.length > max) throw new BadRequestException(`${label} wajib diisi (${min}–${max} karakter)`);
    return s;
  }

  /**
   * Per alamat, lalu global, per jam. Percobaan yang ditolak tidak menghabiskan jatah yang lain: alamat yang sudah kena batas tidak ikut
   * menguras jatah global (yang akan memblokir pendaftar sah), dan penolakan global mengembalikan jatah alamatnya.
   */
  private async throttle(caller: string, now: number): Promise<void> {
    const msg = 'terlalu banyak pendaftaran; coba lagi nanti';
    const ipKey = `signup:ip:${caller}`;
    if ((await this.limiter.hit(ipKey, 3_600_000, now)).count > SIGNUPS_PER_IP_PER_HOUR) throw new HttpException(msg, HttpStatus.TOO_MANY_REQUESTS);
    if ((await this.limiter.hit('signup:global', 3_600_000, now)).count > SIGNUPS_PER_HOUR_GLOBAL) {
      await this.limiter.undo('signup:global');
      await this.limiter.undo(ipKey);
      throw new HttpException(msg, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /**
   * Pendaftaran mandiri: membuat usaha (tenant), satu outlet, dan pengguna OWNER dengan uji coba 14 hari, lalu mengirim kode ke email untuk
   * mengatur password. Respons selalu sama, termasuk bila email sudah terdaftar (yang terjadi hanya kode masuk dikirim ke pemiliknya), agar
   * pendaftaran tidak bisa dipakai menebak email pengguna. Isian `website` adalah jebakan untuk bot: bila terisi, pura-pura berhasil.
   */
  async signup(input: { businessName?: unknown; outletName?: unknown; ownerName?: unknown; email?: unknown; website?: unknown }, caller: string): Promise<{ ok: true }> {
    if (typeof input.website === 'string' && input.website.trim() !== '') return { ok: true };
    const businessName = this.text('nama usaha', input.businessName, 2, 60);
    const outletName = this.text('nama outlet', input.outletName, 2, 60);
    const ownerName = this.text('nama pemilik', input.ownerName ?? '', 2, 60);
    const email = normalizeEmail(input.email);
    if (email.length > 254 || !EMAIL_RE.test(email)) throw new BadRequestException('format email tidak valid');
    await this.throttle(caller, this.clock());

    const existing = (await this.db.admin.query('select 1 from dashboard_user where lower(email) = $1', [email])).rowCount > 0;
    if (!existing) {
      const base = slug(businessName, 24) || 'usaha';
      await this.db.driver.transaction(async (q) => {
        let tenantId = '';
        for (let i = 0; i < 5 && !tenantId; i++) {
          const candidate = `${base}-${randomBytes(2).toString('hex')}`;
          if ((await q.query('select 1 from tenant where id = $1', [candidate])).rowCount === 0) tenantId = candidate;
        }
        if (!tenantId) throw new HttpException('gagal membuat akun; coba lagi', HttpStatus.SERVICE_UNAVAILABLE);
        const outletId = `${tenantId}-utama`;
        const ownerId = slug(email.split('@')[0]!, 30) || 'owner';
        await q.query('insert into tenant (id, name) values ($1, $2)', [tenantId, businessName]);
        await q.query('insert into outlet (id, tenant_id, name, terminals, shadow_days) values ($1, $2, $3, $4::jsonb, $5)', [outletId, tenantId, outletName, '[]', DEFAULT_SHADOW_DAYS]);
        await q.query("insert into dashboard_user (tenant_id, user_id, email, role) values ($1, $2, $3, 'OWNER')", [tenantId, ownerId, email]);
        await this.billing.startTrial(tenantId, 'standard', q);
        await q.query("insert into audit_log (tenant_id, actor, action, detail) values ($1, 'signup', 'signup.self', $2::jsonb)", [tenantId, JSON.stringify({ ownerName, outletId })]);
      });
    }
    // Kode untuk mengatur password (akun baru) atau masuk (akun lama); pembatas kirim ulang dan per alamat dijaga LoginService.
    await this.login.requestCode(email, caller, 'reset');
    return { ok: true };
  }
}
