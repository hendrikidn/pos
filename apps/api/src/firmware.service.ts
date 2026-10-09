import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { AdminAuth } from './auth';
import { Database } from './db/database';
import { CLOCK, type Clock } from './pipeline.service';
import { RateLimiter } from './rate-limit';

export const FW_MIN_SIZE = 65_536;
export const FW_MAX_SIZE = 0x1e0000;
const TOKEN = /^[a-z0-9_.-]{2,24}$/;
const VERSION = /^[A-Za-z0-9_.-]{1,24}$/;
/** Nomor chip di kepala citra ESP (offset 12) untuk papan yang dikenal. */
const CHIP_ID: Record<string, number> = { esp32c3: 5 };

/** Pesan yang ditandatangani rilis; HARUS sama dengan fw_canonical() di firmware (core/fw.c). */
export const fwCanonical = (m: { board: string; channel: string; version: string; build: number; size: number; sha256: string }) =>
  `anatta-fw1|${m.board}|${m.channel}|${m.version}|${m.build}|${m.size}|${m.sha256}`;

/** Kunci rilis yang dipercaya: SPKI base64 dipisah koma (beberapa untuk rotasi kunci). */
export function releaseKeys(raw = process.env['FIRMWARE_RELEASE_PUBKEY']): ReturnType<typeof createPublicKey>[] {
  const keys: ReturnType<typeof createPublicKey>[] = [];
  for (const b64 of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    try {
      const k = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
      if (k.asymmetricKeyType === 'ec' && k.asymmetricKeyDetails?.namedCurve === 'prime256v1') keys.push(k);
    } catch { /* kunci rusak diabaikan: tanpa kunci sah, unggahan ditolak */ }
  }
  return keys;
}

export function verifyRelease(m: Parameters<typeof fwCanonical>[0], signature: string, keys = releaseKeys()): boolean {
  const sig = Buffer.from(signature, 'base64url');
  if (sig.length !== 64) return false;
  return keys.some((k) => { try { return cryptoVerify('sha256', Buffer.from(fwCanonical(m)), { key: k, dsaEncoding: 'ieee-p1363' }, sig); } catch { return false; } });
}

export interface PublishInput { board?: unknown; channel?: unknown; version?: unknown; build?: unknown; notes?: unknown; binary?: unknown; signature?: unknown }

const LATEST_PER_HOUR = 120;
const DOWNLOADS_PER_HOUR = 30;

@Injectable()
export class FirmwareService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  /**
   * Mengunggah rilis (admin). Wajib: kunci rilis dikonfigurasi di server, tanda tangan sah atas (papan, kanal, versi, build, ukuran, sha256), citra berkepala
   * ESP yang sesuai papan, ukuran dalam batas slot, dan nomor build lebih besar dari rilis mana pun sebelumnya di papan dan kanal itu.
   */
  async publish(admin: AdminAuth, input: PublishInput): Promise<{ id: number; sha256: string; size: number }> {
    const keys = releaseKeys();
    if (keys.length === 0) throw new ServiceUnavailableException('FIRMWARE_RELEASE_PUBKEY belum diisi di server; unggahan firmware dinonaktifkan');
    const need = (ok: unknown, m: string) => { if (!ok) throw new BadRequestException(m); };
    need(typeof input.board === 'string' && TOKEN.test(input.board), 'board tidak valid (huruf kecil, angka, . _ -; 2–24)');
    need(typeof input.channel === 'string' && /^[a-z0-9_.-]{2,16}$/.test(input.channel), 'channel tidak valid');
    need(typeof input.version === 'string' && VERSION.test(input.version), 'version tidak valid');
    need(Number.isInteger(input.build) && (input.build as number) > 0 && (input.build as number) < 2_000_000_000, 'build harus bilangan bulat positif');
    need(typeof input.binary === 'string' && input.binary.length > 0 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(input.binary), 'binary harus base64');
    need(typeof input.signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(input.signature), 'signature harus ECDSA P-256 r||s base64url (86 karakter)');
    const notes = input.notes === undefined || input.notes === null || input.notes === '' ? null : typeof input.notes === 'string' ? input.notes.trim().slice(0, 500) : undefined;
    need(notes !== undefined, 'notes harus teks');
    const data = Buffer.from(input.binary as string, 'base64');
    need(data.length >= FW_MIN_SIZE && data.length <= FW_MAX_SIZE, `ukuran firmware harus ${FW_MIN_SIZE}–${FW_MAX_SIZE} byte`);
    need(data[0] === 0xe9, 'bukan citra firmware ESP (byte pertama harus 0xE9)');
    const chip = CHIP_ID[input.board as string];
    need(chip === undefined || data.readUInt16LE(12) === chip, `citra ini bukan untuk papan ${input.board} (chip id salah)`);
    const meta = { board: input.board as string, channel: input.channel as string, version: input.version as string, build: input.build as number, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    need(verifyRelease(meta, input.signature as string, keys), 'tanda tangan rilis tidak sah: tanda tangani dengan kunci rilis (tools/sign_firmware.mts)');
    const top = (await this.db.admin.query<{ b: number | null }>('select max(build) as b from firmware_release where board = $1 and channel = $2', [meta.board, meta.channel])).rows[0]?.b;
    if (top !== null && top !== undefined && meta.build <= top) throw new ConflictException(`build harus lebih besar dari ${top} (rilis terakhir di ${meta.board}/${meta.channel})`);
    const r = await this.db.admin.query<{ id: string }>(
      'insert into firmware_release (board, channel, version, build, size, sha256, signature, notes, data, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id',
      [meta.board, meta.channel, meta.version, meta.build, meta.size, meta.sha256, input.signature, notes, data, admin.adminId],
    );
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'admin', actor: admin.adminId, action: 'firmware.publish', ...meta })}\n`);
    return { id: Number(r.rows[0]!.id), sha256: meta.sha256, size: meta.size };
  }

  async list() {
    return (await this.db.admin.query<{ id: string; board: string; channel: string; version: string; build: number; size: number; sha256: string; notes: string | null; created_by: string; created_at: string; revoked_at: string | null; revoked_reason: string | null }>(
      'select id, board, channel, version, build, size, sha256, notes, created_by, created_at, revoked_at, revoked_reason from firmware_release order by board, channel, build desc limit 200',
    )).rows.map((r) => ({ id: Number(r.id), board: r.board, channel: r.channel, version: r.version, build: r.build, size: r.size, sha256: r.sha256, notes: r.notes, createdBy: r.created_by, createdAt: r.created_at, revokedAt: r.revoked_at, revokedReason: r.revoked_reason }));
  }

  /** Menarik rilis: perangkat tidak lagi ditawari. Yang sudah memasangnya tetap (tidak ada pembatalan paksa). */
  async revoke(admin: AdminAuth, id: number, reason: unknown): Promise<void> {
    const why = typeof reason === 'string' ? reason.trim() : '';
    if (why.length < 3 || why.length > 200) throw new BadRequestException('alasan wajib (3–200 karakter)');
    const r = await this.db.admin.query('update firmware_release set revoked_at = now(), revoked_reason = $2 where id = $1 and revoked_at is null', [id, why]);
    if (r.rowCount === 0) throw new NotFoundException('rilis tidak ditemukan atau sudah ditarik');
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'admin', actor: admin.adminId, action: 'firmware.revoke', id, reason: why })}\n`);
  }

  /** Manifest rilis terbaru yang lebih baru dari `build` milik perangkat, atau `{ update: false }`. Publik (firmware bukan rahasia; keamanannya dari tanda tangan). */
  async latest(params: { board?: unknown; channel?: unknown; build?: unknown }, caller: string) {
    await this.limiter.enforce(`fw:latest:${caller}`, LATEST_PER_HOUR, 3_600_000, this.clock(), 'terlalu banyak pemeriksaan pembaruan; coba lagi nanti');
    if (typeof params.board !== 'string' || !TOKEN.test(params.board)) throw new BadRequestException('board tidak valid');
    const channel = typeof params.channel === 'string' && /^[a-z0-9_.-]{2,16}$/.test(params.channel) ? params.channel : 'stable';
    const build = typeof params.build === 'string' && /^\d{1,10}$/.test(params.build) ? Number(params.build) : 0;
    const r = (await this.db.admin.query<{ id: string; version: string; build: number; size: number; sha256: string; signature: string; notes: string | null }>(
      'select id, version, build, size, sha256, signature, notes from firmware_release where board = $1 and channel = $2 and revoked_at is null and build > $3 order by build desc limit 1',
      [params.board, channel, build],
    )).rows[0];
    if (!r) return { update: false };
    return { update: true, board: params.board, channel, version: r.version, build: r.build, size: r.size, sha256: r.sha256, signature: r.signature, url: `/v1/public/firmware/${r.id}/download`, notes: r.notes };
  }

  async download(id: number, caller: string): Promise<{ data: Buffer; sha256: string }> {
    await this.limiter.enforce(`fw:dl:${caller}`, DOWNLOADS_PER_HOUR, 3_600_000, this.clock(), 'terlalu banyak unduhan firmware; coba lagi nanti');
    const r = (await this.db.admin.query<{ data: Buffer; sha256: string }>('select data, sha256 from firmware_release where id = $1 and revoked_at is null', [id])).rows[0];
    if (!r) throw new NotFoundException('rilis tidak ditemukan');
    return { data: r.data, sha256: r.sha256 };
  }

  /** Mencatat versi yang sedang berjalan di perangkat (dari header setoran event); hanya menulis bila berubah atau sudah lebih dari sehari. */
  async noteRunning(deviceId: string, build: unknown, version: unknown): Promise<void> {
    if (typeof build !== 'string' || !/^\d{1,9}$/.test(build) || typeof version !== 'string' || !VERSION.test(version)) return;
    await this.db.admin.query(
      `update device set firmware_build = $2, firmware_version = $3, firmware_seen_at = now()
       where id = $1 and (firmware_build is distinct from $2 or firmware_version is distinct from $3 or firmware_seen_at is null or firmware_seen_at < now() - interval '1 day')`,
      [deviceId, Number(build), version],
    );
  }
}
