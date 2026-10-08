import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { GENESIS_HASH, hashEvent, isEventType, MAX_EVENT_LINES, MAX_LINE_QTY, RECEIPT_TOKEN, type EventType, type PosEvent } from '@pos/events';
import type { DeviceAuth } from './auth';
import { Database } from './db/database';
import { clampShadowStart, GO_LIVE_TYPES } from './shadow';

export const MAX_BATCH = 500;

export interface IngestIssue {
  seq: number;
  kind: 'HASH_MISMATCH' | 'CHAIN_BROKEN' | 'SEQ_GAP' | 'DUPLICATE_MISMATCH' | 'BAD_SIGNATURE' | 'MISSING_SIGNATURE';
  detail: string;
}

export interface IngestResult {
  ackedSeq: number;
  accepted: number;
  duplicates: number;
  issues: IngestIssue[];
  serverTime: number;
}

type Hashable = Parameters<typeof hashEvent>[0];

type Payload = Record<string, unknown>;
const str = (p: Payload, k: string) => typeof p[k] === 'string' && p[k] !== '';
const num = (p: Payload, k: string) => typeof p[k] === 'number' && Number.isFinite(p[k]);
const bool = (p: Payload, k: string) => typeof p[k] === 'boolean';
const oneOf = (p: Payload, k: string, values: readonly string[]) => typeof p[k] === 'string' && values.includes(p[k] as string);
const METHODS = ['CASH', 'QRIS', 'EDC_DEBIT', 'EDC_CREDIT'] as const;

/** Layar dapur hanya mengubah status tiket (dan heartbeat); token yang bocor tidak boleh bisa memalsukan pembayaran. */
const KDS_EVENT_TYPES: readonly EventType[] = ['kitchen.status_changed', 'device.heartbeat'];

const MAX_LINE_ITEMS = MAX_EVENT_LINES;

/** Rincian total opsional: semua angka bilangan bulat (pembulatan boleh negatif). */
function badBreakdown(p: Payload): string | null {
  const b = p['breakdown'];
  if (b === undefined) return null;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return 'breakdown harus objek';
  const o = b as Payload;
  for (const k of ['subtotal', 'discount', 'service', 'tax', 'rounding']) if (!Number.isInteger(o[k])) return `breakdown.${k} harus bilangan bulat`;
  return null;
}

/** Item pesanan opsional: dibatasi jumlah dan panjangnya agar satu event tidak bisa membengkak. */
function badItems(p: Payload): string | null {
  const v = p['items'];
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_LINE_ITEMS) return `items harus berisi 1–${MAX_LINE_ITEMS} baris`;
  for (const raw of v as unknown[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'baris items bukan objek';
    const l = raw as Payload;
    if (!str(l, 'itemId') || (l['itemId'] as string).length > 64) return 'itemId tidak valid';
    if (!str(l, 'name') || (l['name'] as string).length > 120) return 'nama item tidak valid';
    if (!Number.isInteger(l['qty']) || (l['qty'] as number) < 1 || (l['qty'] as number) > MAX_LINE_QTY) return `qty harus bilangan bulat 1–${MAX_LINE_QTY}`;
    if (!Number.isInteger(l['unitPrice']) || (l['unitPrice'] as number) < 0) return 'unitPrice harus bilangan bulat ≥ 0';
    if (l['sentQty'] !== undefined && (!Number.isInteger(l['sentQty']) || (l['sentQty'] as number) < 0 || (l['sentQty'] as number) > (l['qty'] as number))) return 'sentQty harus bilangan bulat 0..qty';
    if (l['note'] !== undefined && (typeof l['note'] !== 'string' || l['note'].length > 140)) return 'note harus teks maks. 140';
    if (l['options'] !== undefined) {
      if (!Array.isArray(l['options']) || l['options'].length > 40) return 'options harus berisi maks. 40 baris';
      for (const raw of l['options'] as unknown[]) {
        const o = raw as Payload | null;
        if (typeof o !== 'object' || o === null || Array.isArray(o)) return 'baris options bukan objek';
        if (o['id'] !== undefined && (!str(o, 'id') || (o['id'] as string).length > 32)) return 'id opsi tidak valid';
        if (!str(o, 'group') || (o['group'] as string).length > 40 || !str(o, 'name') || (o['name'] as string).length > 40) return 'nama grup/opsi tidak valid';
        if (!Number.isInteger(o['price']) || (o['price'] as number) < 0) return 'harga opsi harus bilangan bulat ≥ 0';
      }
    }
  }
  return null;
}

/**
 * Pemeriksaan isi per tipe event. Tanpa ini, satu event dengan field hilang (bug firmware atau perangkat nakal)
 * bisa membuat mesin aturan gagal untuk seluruh outlet.
 */
const PAYLOAD_CHECKS: Record<EventType, (p: Payload) => string | null> = {
  'order.created': (p) => {
    if (!str(p, 'orderId') || !oneOf(p, 'orderType', ['DINE_IN', 'TAKE_AWAY', 'EMPLOYEE'])) return 'orderId/orderType tidak valid';
    if (p['employeeId'] !== undefined && !str(p, 'employeeId')) return 'employeeId tidak valid';
    if (p['approverId'] !== undefined && (!str(p, 'approverId') || p['orderType'] !== 'EMPLOYEE')) return 'approverId hanya untuk order karyawan';
    if (p['tableNo'] !== undefined && (!str(p, 'tableNo') || (p['tableNo'] as string).length > 10)) return 'tableNo tidak valid';
    return null;
  },
  'order.sent_to_kitchen': (p) => (str(p, 'orderId') ? badItems(p) : 'orderId wajib'),
  'order.table_changed': (p) =>
    str(p, 'orderId') && str(p, 'to') && (p['to'] as string).length <= 10 && (p['from'] === undefined || (str(p, 'from') && (p['from'] as string).length <= 10))
      ? null : 'orderId/to/from tidak valid',
  'order.handed_off': (p) => {
    if (!str(p, 'orderId') || !oneOf(p, 'orderType', ['DINE_IN', 'TAKE_AWAY'])) return 'orderId/orderType tidak valid (order karyawan tidak bisa diserahkan)';
    if (p['tableNo'] !== undefined && (!str(p, 'tableNo') || (p['tableNo'] as string).length > 10)) return 'tableNo tidak valid';
    if (p['items'] === undefined) return 'items wajib';
    return badItems(p);
  },
  'order.handoff_reclaimed': (p) => (str(p, 'orderId') ? null : 'orderId wajib'),
  'bill.hold_reason': (p) =>
    str(p, 'orderId') && str(p, 'reason') && (p['reason'] as string).length <= 40 && Number.isInteger(p['heldMinutes']) && (p['heldMinutes'] as number) >= 0
      ? null : 'orderId/reason/heldMinutes tidak valid',
  'order.items_moved': (p) =>
    str(p, 'fromOrderId') && str(p, 'toOrderId') && p['fromOrderId'] !== p['toOrderId'] && oneOf(p, 'kind', ['SPLIT', 'MERGE']) && bool(p, 'sent')
    && (p['kitchen'] === undefined || oneOf(p, 'kitchen', ['COOKING', 'READY', 'SERVED'])) && p['items'] !== undefined
      ? badItems(p) : 'field pemindahan item tidak valid',
  'kitchen.status_changed': (p) => (str(p, 'orderId') && oneOf(p, 'status', ['COOKING', 'READY', 'SERVED']) ? null : 'orderId/status tidak valid'),
  'bill.printed': (p) => (str(p, 'orderId') && num(p, 'total') ? badItems(p) ?? badBreakdown(p) : 'orderId/total tidak valid'),
  'discount.applied': (p) =>
    str(p, 'orderId') && oneOf(p, 'kind', ['MANUAL', 'MEMBER', 'COUPON']) && num(p, 'amount') && num(p, 'percent') && bool(p, 'verified')
      ? null : 'field diskon tidak valid',
  'payment.received': (p) => (str(p, 'orderId') && oneOf(p, 'method', METHODS) && num(p, 'amount') ? null : 'orderId/method/amount tidak valid'),
  'payment.method_changed': (p) => (str(p, 'orderId') && oneOf(p, 'from', METHODS) && oneOf(p, 'to', METHODS) ? null : 'field tidak valid'),
  'receipt.printed': (p) => (str(p, 'orderId') ? null : 'orderId wajib'),
  'receipt.digital': (p) => (str(p, 'orderId') && typeof p['token'] === 'string' && RECEIPT_TOKEN.test(p['token']) ? null : 'orderId/token tidak valid'),
  'receipt.declined': (p) => (str(p, 'orderId') ? null : 'orderId wajib'),
  'void.approved': (p) =>
    str(p, 'orderId') && str(p, 'reasonCode') && num(p, 'amount') && Array.isArray(p['approverIds']) && (p['approverIds'] as unknown[]).every((a) => typeof a === 'string')
      ? null : 'field void tidak valid',
  'refund.created': (p) =>
    str(p, 'refundId') && str(p, 'originalOrderId') && num(p, 'amount') && oneOf(p, 'method', METHODS) && str(p, 'approverId')
      ? null : 'field refund tidak valid',
  'drawer.opened': () => null,
  'printer.status': (p) =>
    oneOf(p, 'state', ['ok', 'paperNearEnd', 'paperOut', 'coverOpen', 'overheated', 'disconnected', 'unknown']) && oneOf(p, 'source', ['device', 'claim'])
      ? null : 'state/source tidak valid',
  'printer.paper_claim': (p) => (bool(p, 'active') ? null : 'active wajib boolean'),
  'device.heartbeat': (p) =>
    oneOf(p, 'kind', ['sensor', 'printer', 'terminal', 'kds']) && (p['status'] === undefined || oneOf(p, 'status', ['ok', 'no_radar', 'blocked']))
      ? null
      : 'kind/status tidak valid',
  'device.posture': (p) =>
    bool(p, 'autoTime') && bool(p, 'adb') && bool(p, 'devOptions') && bool(p, 'kiosk') && bool(p, 'rooted') && str(p, 'appVersion') && (p['appVersion'] as string).length <= 40
      ? null : 'field posture tidak valid',
  'shift.opened': (p) => (str(p, 'shiftId') && num(p, 'openingCash') ? null : 'shiftId/openingCash tidak valid'),
  'cash.counted': (p) =>
    str(p, 'shiftId') && num(p, 'counted') && num(p, 'expected') && (p['tracked'] === undefined || bool(p, 'tracked')) ? null : 'shiftId/counted/expected/tracked tidak valid',
  'shift.closed': (p) => (str(p, 'shiftId') ? null : 'shiftId wajib'),
  'presence.session': (p) =>
    num(p, 'start') && num(p, 'end') && num(p, 'peakMove') && num(p, 'peakStatic') && (p['end'] as number) >= (p['start'] as number)
      ? null : 'start/end/peak tidak valid',
};


/** Memeriksa bentuk satu event dari perangkat. Mengembalikan pesan kesalahan, atau event bertipe jika valid. */
export function parseEvent(raw: unknown): PosEvent | string {
  if (typeof raw !== 'object' || raw === null) return 'event bukan objek';
  const e = raw as Record<string, unknown>;
  if (e['v'] !== 1) return 'versi event tidak didukung';
  if (!isEventType(e['type'])) return `tipe event tidak dikenal: ${String(e['type'])}`;
  for (const f of ['id', 'deviceId', 'outletId', 'prevHash', 'hash'] as const) {
    if (typeof e[f] !== 'string' || e[f] === '') return `field ${f} wajib string`;
  }
  if (!Number.isInteger(e['seq']) || (e['seq'] as number) < 1) return 'seq harus bilangan bulat ≥ 1';
  if (typeof e['deviceTime'] !== 'number' || !Number.isFinite(e['deviceTime'])) return 'deviceTime harus angka';
  if (typeof e['clockOffsetMs'] !== 'number' || !Number.isFinite(e['clockOffsetMs'])) return 'clockOffsetMs harus angka';
  if (e['actorId'] !== null && typeof e['actorId'] !== 'string') return 'actorId harus string atau null';
  if (e['sig'] !== undefined && (typeof e['sig'] !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(e['sig']))) return 'sig harus base64url';
  if (typeof e['payload'] !== 'object' || e['payload'] === null || Array.isArray(e['payload'])) return 'payload harus objek';
  const bad = PAYLOAD_CHECKS[e['type']](e['payload'] as Payload);
  if (bad) return `payload ${e['type']}: ${bad}`;
  return raw as PosEvent;
}

/** Mengurai kunci publik SPKI (base64) milik perangkat; mengembalikan null bila bukan kunci P-256 yang sah. */
export function parsePublicKey(b64: string): KeyObject | null {
  try {
    const key = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : null;
  } catch {
    return null;
  }
}

/** Memeriksa tanda tangan ES256 (r||s) atas string hash event. */
export function verifySignature(key: KeyObject, hash: string, sig: string): boolean {
  try {
    return cryptoVerify('sha256', Buffer.from(hash, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}

@Injectable()
export class IngestService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /**
   * Menyimpan batch event dari satu perangkat. Idempoten per (device, seq).
   * Event yang tidak lolos pemeriksaan hash/rantai tetap disimpan (sebagai bukti) dan ditandai,
   * lalu dilaporkan di `issues` dan dinilai oleh aturan R24.
   */
  async ingest(auth: DeviceAuth, rawEvents: unknown, now = Date.now()): Promise<IngestResult> {
    if (!Array.isArray(rawEvents)) throw new BadRequestException('events harus array');
    if (rawEvents.length > MAX_BATCH) throw new BadRequestException(`maksimal ${MAX_BATCH} event per batch`);

    const events: PosEvent[] = [];
    for (const [i, raw] of rawEvents.entries()) {
      const parsed = parseEvent(raw);
      if (typeof parsed === 'string') throw new BadRequestException(`event[${i}]: ${parsed}`);
      if (parsed.deviceId !== auth.deviceId) throw new BadRequestException(`event[${i}]: deviceId tidak sesuai token`);
      if (parsed.outletId !== auth.outletId) throw new BadRequestException(`event[${i}]: outletId tidak sesuai token`);
      if (auth.deviceKind === 'kds' && !KDS_EVENT_TYPES.includes(parsed.type)) {
        throw new BadRequestException(`event[${i}]: layar dapur hanya boleh mengirim ${KDS_EVENT_TYPES.join(', ')}`);
      }
      events.push(parsed);
    }
    events.sort((a, b) => a.seq - b.seq);

    return this.db.tenantTx(auth.tenantId, async (q) => {
      const dev = (
        await q.query<{ last_seq: number; last_hash: string; public_key: string | null }>(
          'select last_seq, last_hash, public_key from device where id = $1 for update',
          [auth.deviceId],
        )
      ).rows[0];
      if (!dev) throw new BadRequestException('perangkat tidak ditemukan');
      // Setelah kunci terdaftar, tanda tangan wajib. Sebelum itu, event diterima tanpa pemeriksaan tanda tangan.
      const deviceKey = dev.public_key ? parsePublicKey(dev.public_key) : null;
      const checkSig = async (e: PosEvent): Promise<IngestIssue['kind'] | null> => {
        if (!dev.public_key) return null;
        let kind: IngestIssue['kind'] | null = null;
        if (!e.sig) kind = 'MISSING_SIGNATURE';
        else if (!deviceKey || !verifySignature(deviceKey, e.hash, e.sig)) kind = 'BAD_SIGNATURE';
        if (kind) await note({ seq: e.seq, kind, detail: kind === 'MISSING_SIGNATURE' ? 'perangkat ini wajib menandatangani event' : 'tanda tangan tidak sah' });
        return kind;
      };

      let lastSeq = dev.last_seq;
      let lastHash = dev.last_hash === '' ? GENESIS_HASH : dev.last_hash;
      let accepted = 0;
      /** Waktu terkoreksi event bermakna yang diterima, untuk menandai awal mode shadow. */
      const goLive: number[] = [];
      const accept = (e: PosEvent) => {
        accepted++;
        if ((GO_LIVE_TYPES as readonly string[]).includes(e.type)) goLive.push(e.deviceTime - e.clockOffsetMs);
      };
      let duplicates = 0;
      const issues: IngestIssue[] = [];
      const note = async (issue: IngestIssue) => {
        issues.push(issue);
        await q.query(
          'insert into integrity_issue (tenant_id, outlet_id, device_id, seq, kind, detail) values ($1, $2, $3, $4, $5, $6)',
          [auth.tenantId, auth.outletId, auth.deviceId, issue.seq, issue.kind, issue.detail],
        );
      };

      for (const e of events) {
        const insert = async (integrity: IngestIssue['kind'] | null) =>
          q.query(
            `insert into event (id, tenant_id, outlet_id, device_id, seq, type, device_time_ms, clock_offset_ms,
                                actor_id, prev_hash, hash, payload, integrity, sig)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)`,
            [
              e.id, auth.tenantId, auth.outletId, auth.deviceId, e.seq, e.type, e.deviceTime, e.clockOffsetMs,
              e.actorId, e.prevHash, e.hash, JSON.stringify(e.payload), integrity, e.sig ?? null,
            ],
          );

        if (e.seq <= lastSeq) {
          const stored = (
            await q.query<{ hash: string }>('select hash from event where device_id = $1 and seq = $2', [auth.deviceId, e.seq])
          ).rows[0];
          if (stored) {
            if (stored.hash !== e.hash) {
              await note({ seq: e.seq, kind: 'DUPLICATE_MISMATCH', detail: 'seq sudah ada dengan isi berbeda' });
            }
            duplicates++;
            continue;
          }
          // Event susulan: seq-nya lebih rendah dari yang terakhir diterima tetapi belum tersimpan (batch tiba tidak berurutan).
          const { hash: claimed, sig: _s, ...unsigned } = e;
          let late: IngestIssue['kind'] | null = null;
          if (hashEvent(unsigned as Hashable) !== claimed) {
            late = 'HASH_MISMATCH';
            await note({ seq: e.seq, kind: late, detail: 'isi event tidak sesuai hash' });
          }
          late ??= await checkSig(e);
          await insert(late);
          accept(e);
          continue;
        }

        let integrity: IngestIssue['kind'] | null = null;
        const { hash, sig: _sig, ...rest } = e;
        if (hashEvent(rest as Hashable) !== hash) {
          integrity = 'HASH_MISMATCH';
          await note({ seq: e.seq, kind: integrity, detail: 'isi event tidak sesuai hash' });
        }
        if (e.seq !== lastSeq + 1) {
          integrity ??= 'SEQ_GAP';
          await note({ seq: e.seq, kind: 'SEQ_GAP', detail: `seq ${lastSeq + 1}..${e.seq - 1} hilang` });
        } else if (e.prevHash !== lastHash) {
          integrity ??= 'CHAIN_BROKEN';
          await note({ seq: e.seq, kind: 'CHAIN_BROKEN', detail: 'prevHash tidak cocok dengan event sebelumnya' });
        }

        integrity ??= await checkSig(e);
        await insert(integrity);
        lastSeq = e.seq;
        lastHash = e.hash;
        accept(e);
      }

      // Mode shadow mulai berhitung dari aktivitas pertama yang bermakna, bukan dari saat outlet dibuat atau alat dinyalakan.
      if (goLive.length > 0) {
        await q.query('update outlet set shadow_started_ms = $2 where id = $1 and shadow_days > 0 and shadow_started_ms is null', [
          auth.outletId, clampShadowStart(Math.min(...goLive), now),
        ]);
      }

      const serverTime = now;
      await q.query('update device set last_seq = $2, last_hash = $3, last_seen_ms = $4 where id = $1', [
        auth.deviceId, lastSeq, lastHash, serverTime,
      ]);
      return { ackedSeq: lastSeq, accepted, duplicates, issues, serverTime };
    });
  }
}
