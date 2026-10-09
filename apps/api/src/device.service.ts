import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiAuth, DeviceAuth } from './auth';
import { Database } from './db/database';
import { parsePublicKey } from './ingest.service';

@Injectable()
export class DeviceService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /**
   * Pendaftaran kunci publik perangkat (sekali). Setelah terdaftar, event perangkat harus bertanda tangan kunci itu.
   * Mendaftarkan kunci yang sama lagi aman (idempoten). Kunci berbeda ditolak sampai owner mengatur ulang.
   */
  async enrollKey(device: DeviceAuth, publicKey: unknown): Promise<{ enrolled: true; alreadyEnrolled: boolean }> {
    if (typeof publicKey !== 'string' || publicKey.length > 400 || !parsePublicKey(publicKey)) {
      throw new BadRequestException('publicKey harus kunci publik ECDSA P-256 (SPKI DER, base64)');
    }
    return this.db.tenantTx(device.tenantId, async (q) => {
      const cur = (await q.query<{ public_key: string | null }>('select public_key from device where id = $1 for update', [device.deviceId])).rows[0];
      if (!cur) throw new NotFoundException('perangkat tidak ditemukan');
      if (cur.public_key) {
        if (cur.public_key === publicKey) return { enrolled: true as const, alreadyEnrolled: true };
        throw new ConflictException('perangkat sudah memiliki kunci berbeda; minta owner mengatur ulang kunci');
      }
      await q.query('update device set public_key = $2 where id = $1', [device.deviceId, publicKey]);
      await q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [
        device.tenantId, `device:${device.deviceId}`, 'device.key.enroll', JSON.stringify({ deviceId: device.deviceId }),
      ]);
      return { enrolled: true as const, alreadyEnrolled: false };
    });
  }

  /** Owner mengatur ulang kunci (perangkat diganti atau data aplikasi terhapus). Tercatat di audit. */
  async resetKey(auth: ApiAuth, deviceId: string): Promise<void> {
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await q.query('update device set public_key = null where id = $1', [deviceId]);
      if (r.rowCount === 0) throw new NotFoundException('perangkat tidak ditemukan');
      await q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [
        auth.tenantId, auth.userId, 'device.key.reset', JSON.stringify({ deviceId }),
      ]);
    });
  }

  list(auth: ApiAuth) {
    return this.db.tenantTx(auth.tenantId, async (q) =>
      (
        await q.query(
          `select id, kind, outlet_id, terminal_id, (public_key is not null) as key_enrolled, last_seq, last_seen_ms, revoked_at, firmware_version, firmware_build from device order by outlet_id, id`,
        )
      ).rows,
    );
  }
}
