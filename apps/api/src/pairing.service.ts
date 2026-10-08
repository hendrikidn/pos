import { createHash, randomInt } from 'node:crypto';
import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException,
} from '@nestjs/common';
import { newToken, sha256, SUSPENDED_MESSAGE, type ApiAuth } from './auth';
import { Database } from './db/database';
import type { Queryable } from './db/driver';
import { CLOCK, type Clock } from './pipeline.service';
import { RateLimiter } from './rate-limit';

export const PAIRING_TTL_MS = 15 * 60 * 1000;
/** Tanpa 0/O/1/I agar mudah diketik dari layar. 32^8 ≈ 10^12 kemungkinan. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const KINDS = ['terminal', 'sensor', 'kds'] as const;
type Kind = (typeof KINDS)[number];

/** Batas percobaan kode salah per alamat: 10 kali per 15 menit. */
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

export interface PairingInput {
  outletId?: unknown;
  kind?: unknown;
  deviceId?: unknown;
  terminalId?: unknown;
}

export interface EnrollResult {
  deviceId: string;
  token: string;
  kind: Kind;
  outletId: string;
  terminalId: string | null;
}

/** Huruf besar, tanpa pemisah: pengguna boleh mengetik `7k4m-9pxq` atau `7K4M 9PXQ`. */
export const normalizeCode = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (normalized: string) => createHash('sha256').update(`pairing:${normalized}`).digest('hex');

function generateCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}
const display = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/**
 * Kapabilitas `kds` outlet mengikuti perangkat layar dapur yang masih aktif: aturan R2 versi KDS (status dapur) hanya dipakai bila
 * dapur benar-benar punya layar, selain itu dipakai versi proksi (waktu sejak dikirim). Perubahan dicatat di audit.
 */
async function followKdsCapability(q: Queryable, tenantId: string, outletId: string, actor: string): Promise<void> {
  const active = (await q.query<{ n: number }>("select count(*)::int as n from device where outlet_id = $1 and kind = 'kds' and revoked_at is null", [outletId])).rows[0]!.n > 0;
  const r = await q.query(
    `update outlet set capabilities = jsonb_set(capabilities, '{kds}', $2::jsonb)
     where id = $1 and coalesce((capabilities->>'kds')::boolean, false) <> $3::boolean`,
    [outletId, JSON.stringify(active), active],
  );
  if (r.rowCount) {
    await q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [
      tenantId, actor, 'outlet.capability.kds', JSON.stringify({ outletId, kds: active }),
    ]);
  }
}

/** Kode pairing salah (penanda di dalam transaksi; kegagalan dicatat ke pembatas setelah transaksi selesai). */
class BadCode extends Error {}

@Injectable()
export class PairingService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  /** Owner/ops membuat kode. Kode polos hanya dikembalikan sekali; yang tersimpan hanya hash-nya. */
  async create(auth: ApiAuth, input: PairingInput) {
    const outletId = typeof input.outletId === 'string' ? input.outletId : '';
    const kind = input.kind as Kind;
    if (!outletId) throw new BadRequestException('outletId wajib');
    if (!KINDS.includes(kind)) throw new BadRequestException(`kind harus salah satu dari: ${KINDS.join(', ')}`);

    const terminalId = input.terminalId === undefined || input.terminalId === '' ? null : input.terminalId;
    if (terminalId !== null && (typeof terminalId !== 'string' || !ID_RE.test(terminalId))) {
      throw new BadRequestException('terminalId hanya huruf kecil, angka, dan tanda hubung (2–40 karakter)');
    }
    if (terminalId !== null && kind !== 'sensor') throw new BadRequestException('terminalId hanya untuk sensor');

    let deviceId: string;
    if (input.deviceId === undefined || input.deviceId === '') {
      deviceId = `${kind}-${outletId}-${randomInt(1000, 10000)}`.toLowerCase();
    } else if (typeof input.deviceId === 'string' && ID_RE.test(input.deviceId)) {
      deviceId = input.deviceId;
    } else {
      throw new BadRequestException('deviceId hanya huruf kecil, angka, dan tanda hubung (2–40 karakter)');
    }
    if (!ID_RE.test(deviceId)) throw new BadRequestException('deviceId yang dihasilkan tidak valid; beri deviceId sendiri');

    const now = this.clock();
    const taken = await this.db.admin.query(
      `select 1 from device where id = $1
       union all select 1 from pairing_code where device_id = $1 and used_at is null and expires_at > to_timestamp($2 / 1000.0)`,
      [deviceId, now],
    );
    if (taken.rowCount) throw new ConflictException('deviceId sudah dipakai atau masih punya kode pairing aktif');

    const expiresAt = now + PAIRING_TTL_MS;
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const outlet = await q.query('select 1 from outlet where id = $1', [outletId]);
      if (!outlet.rowCount) throw new NotFoundException('outlet tidak ditemukan');
      const code = generateCode();
      await q.query(
        `insert into pairing_code (code_hash, tenant_id, outlet_id, device_id, kind, terminal_id, created_by, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0))`,
        [hashCode(code), auth.tenantId, outletId, deviceId, kind, terminalId, auth.userId, expiresAt],
      );
      await q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [
        auth.tenantId, auth.userId, 'device.pairing.create', JSON.stringify({ deviceId, kind, outletId, terminalId }),
      ]);
      return { code: display(code), deviceId, kind, outletId, terminalId, expiresAt: new Date(expiresAt).toISOString() };
    });
  }

  /** Kode yang belum dipakai dan belum kedaluwarsa (tanpa kode polosnya). */
  pending(auth: ApiAuth) {
    return this.db.tenantTx(auth.tenantId, async (q) =>
      (
        await q.query(
          `select device_id, kind, outlet_id, terminal_id, expires_at from pairing_code
           where used_at is null and expires_at > to_timestamp($1 / 1000.0) order by expires_at`,
          [this.clock()],
        )
      ).rows,
    );
  }

  async cancel(auth: ApiAuth, deviceId: string): Promise<void> {
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await q.query('delete from pairing_code where device_id = $1 and used_at is null', [deviceId]);
      if (!r.rowCount) throw new NotFoundException('tidak ada kode pairing aktif untuk perangkat ini');
      await q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [
        auth.tenantId, auth.userId, 'device.pairing.cancel', JSON.stringify({ deviceId }),
      ]);
    });
  }

  /** Perangkat menukar kode dengan token. Tanpa autentikasi: kodenya sendiri yang menjadi kredensial. */
  async redeem(rawCode: unknown, hardwareId: unknown, caller: string): Promise<EnrollResult> {
    const now = this.clock();
    await this.limiter.assertBelow(`pair:fail:${caller}`, MAX_FAILS, now, 'terlalu banyak percobaan; coba lagi nanti');
    const code = typeof rawCode === 'string' ? normalizeCode(rawCode) : '';
    const hw = typeof hardwareId === 'string' ? hardwareId.slice(0, 64) : null;

    try {
      return await this.db.driver.transaction(async (q) => {
        const row = code.length === CODE_LENGTH
          ? (
              await q.query<{
                tenant_id: string; outlet_id: string; device_id: string; kind: Kind; terminal_id: string | null;
                used: boolean; expired: boolean; suspended: boolean;
              }>(
                `select p.tenant_id, p.outlet_id, p.device_id, p.kind, p.terminal_id, p.used_at is not null as used,
                        p.expires_at <= to_timestamp($2 / 1000.0) as expired, t.suspended_at is not null as suspended
                 from pairing_code p join tenant t on t.id = p.tenant_id where p.code_hash = $1 for update of p`,
                [hashCode(code), now],
              )
            ).rows[0]
          : undefined;
        if (!row || row.used || row.expired) {
          // Dicatat SETELAH transaksi dibatalkan (pembatas memakai koneksi lain): lihat `badCode` di bawah.
          throw new BadCode();
        }
        if (row.suspended) throw new ForbiddenException(SUSPENDED_MESSAGE);
        const token = newToken('dev');
        await q.query(
          'insert into device (id, tenant_id, outlet_id, kind, token_hash, terminal_id) values ($1, $2, $3, $4, $5, $6)',
          [row.device_id, row.tenant_id, row.outlet_id, row.kind, sha256(token), row.terminal_id],
        );
        await q.query('update pairing_code set used_at = to_timestamp($2 / 1000.0) where code_hash = $1', [hashCode(code), now]);
        if (row.kind === 'kds') await followKdsCapability(q, row.tenant_id, row.outlet_id, `device:${row.device_id}`);
        await q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [
          row.tenant_id, `device:${row.device_id}`, 'device.pairing.redeem', JSON.stringify({ deviceId: row.device_id, hardwareId: hw }),
        ]);
        return { deviceId: row.device_id, token, kind: row.kind, outletId: row.outlet_id, terminalId: row.terminal_id };
      });
    } catch (e) {
      if (e instanceof BadCode) {
        await this.limiter.hit(`pair:fail:${caller}`, FAIL_WINDOW_MS, now);
        throw new BadRequestException('kode pairing tidak valid atau sudah kedaluwarsa');
      }
      if ((e as { code?: string }).code === '23505') throw new ConflictException('deviceId sudah terdaftar; minta kode pairing baru');
      throw e;
    }
  }

  /** Owner mencabut token perangkat (hilang, dicuri, atau diganti). Event yang sudah ada tetap tersimpan. */
  async revoke(auth: ApiAuth, deviceId: string): Promise<void> {
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await q.query<{ kind: Kind; outlet_id: string }>(
        'update device set revoked_at = now() where id = $1 and revoked_at is null returning kind, outlet_id',
        [deviceId],
      );
      if (!r.rowCount) throw new NotFoundException('perangkat tidak ditemukan atau sudah dicabut');
      if (r.rows[0]!.kind === 'kds') await followKdsCapability(q, auth.tenantId, r.rows[0]!.outlet_id, auth.userId);
      await q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [
        auth.tenantId, auth.userId, 'device.revoke', JSON.stringify({ deviceId }),
      ]);
    });
  }
}
