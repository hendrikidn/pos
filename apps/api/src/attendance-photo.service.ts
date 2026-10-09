import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiAuth, DeviceAuth } from './auth';
import { Database } from './db/database';
import { CLOCK, type Clock } from './pipeline.service';

/** Foto absen: kecil (diperkecil di terminal), JPEG saja. */
export const MAX_PHOTO_BYTES = 150_000;
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

export interface PhotoUpload { hash?: unknown; data?: unknown }

/**
 * Foto saat absen. Terminal mengunggah foto JPEG (base64) dengan sidik jari sha256 yang sama dengan yang dicatat di event absen; server memeriksa
 * bahwa isinya benar JPEG dan sidik jarinya cocok, jadi foto tidak bisa ditukar setelah event ditandatangani. Foto hanya bisa dilihat owner dan
 * manager. Tidak ada pencocokan wajah otomatis: foto adalah bukti untuk ditinjau manusia.
 */
@Injectable()
export class AttendancePhotoService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async store(device: DeviceAuth, input: PhotoUpload, now = this.clock()): Promise<{ stored: boolean }> {
    if (typeof input.hash !== 'string' || !/^[0-9a-f]{64}$/.test(input.hash)) throw new BadRequestException('hash tidak valid');
    if (typeof input.data !== 'string' || input.data.length === 0 || input.data.length > Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) throw new BadRequestException('data foto tidak valid atau terlalu besar');
    const bytes = Buffer.from(input.data, 'base64');
    if (bytes.length < 100 || bytes.length > MAX_PHOTO_BYTES) throw new BadRequestException(`foto maksimal ${MAX_PHOTO_BYTES / 1000} KB`);
    if (!JPEG_MAGIC.every((b, i) => bytes[i] === b)) throw new BadRequestException('foto harus berformat JPEG');
    if (createHash('sha256').update(bytes).digest('hex') !== input.hash) throw new BadRequestException('sidik jari foto tidak cocok dengan isinya');
    return this.db.tenantTx(device.tenantId, async (q) => {
      const r = await q.query('insert into attendance_photo (tenant_id, outlet_id, hash, device_id, size, data, at_ms) values ($1, $2, $3, $4, $5, $6, $7) on conflict (outlet_id, hash) do nothing', [device.tenantId, device.outletId, input.hash, device.deviceId, bytes.length, bytes, now]);
      return { stored: r.rowCount > 0 };
    });
  }

  async get(auth: ApiAuth, outletId: string, hash: string): Promise<{ data: Buffer; mime: string }> {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new NotFoundException('foto tidak ditemukan');
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const r = (await q.query<{ data: Buffer; mime: string }>('select data, mime from attendance_photo where outlet_id = $1 and hash = $2', [outletId, hash])).rows[0];
      if (!r) throw new NotFoundException('foto tidak ditemukan');
      await q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [auth.tenantId, auth.userId, 'attendance.photo.view', JSON.stringify({ outletId, hash: hash.slice(0, 12) })]);
      return { data: Buffer.from(r.data), mime: r.mime };
    });
  }
}
