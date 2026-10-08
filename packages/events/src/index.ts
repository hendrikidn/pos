import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export type PaymentMethod = 'CASH' | 'QRIS' | 'EDC_DEBIT' | 'EDC_CREDIT';
export type OrderType = 'DINE_IN' | 'TAKE_AWAY' | 'EMPLOYEE';
export type KitchenStatus = 'COOKING' | 'READY' | 'SERVED';
export type PrinterState =
  | 'ok' | 'paperNearEnd' | 'paperOut' | 'coverOpen' | 'overheated' | 'disconnected' | 'unknown';

/** Satu baris item pesanan di event. Nama dan harga disalin saat kejadian, karena menu bisa berubah kemudian. */
export interface LineItem {
  itemId: string;
  name: string;
  qty: number;
  /** Harga satuan akhir, sudah termasuk harga opsi. `qty × unitPrice` selalu nilai baris. */
  unitPrice: number;
  /** Varian dan tambahan yang dipilih; harganya sudah termasuk di `unitPrice`. */
  /** `id`: id opsi pada menu (dasar resep opsi untuk stok); tidak ada pada event lama. */
  options?: { id?: string; group: string; name: string; price: number }[];
  /** Catatan kasir untuk dapur. */
  note?: string;
  /** Hanya pada `order.items_moved`: berapa dari `qty` yang sudah dikirim ke dapur (sisanya belum). */
  sentQty?: number;
}

/** Isi event menurut tipe. Menambah tipe event = menambah satu baris di sini. */
export type EventBody =
  | {
      type: 'order.created';
      /**
       * `approverId`: supervisor ke atas yang menyetujui makan karyawan di luar kuota atau untuk diri sendiri (hanya order EMPLOYEE).
       * `tableNo`: nomor meja order dine-in (untuk layar dapur); perubahannya tercatat di `order.table_changed`.
       */
      payload: { orderId: string; orderType: OrderType; employeeId?: string; approverId?: string; tableNo?: string };
    }
  | {
      type: 'order.sent_to_kitchen';
      /** `items`: item baru yang dikirim kali ini (selisih dari kiriman sebelumnya). Tidak ada pada event lama. */
      payload: { orderId: string; items?: LineItem[] };
    }
  | { type: 'kitchen.status_changed'; payload: { orderId: string; status: KitchenStatus } }
  | {
      type: 'bill.hold_reason';
      /** Bill tunai dibayar setelah ditahan melebihi batas; `reason` dari daftar baku, `heldMinutes` lama sejak bill dicetak. */
      payload: { orderId: string; reason: string; heldMinutes: number };
    }
  | { type: 'order.table_changed'; payload: { orderId: string; from?: string; to: string } }
  | {
      type: 'order.items_moved';
      payload: {
        fromOrderId: string;
        toOrderId: string;
        /** SPLIT: sebagian item pindah ke order baru. MERGE: seluruh item `fromOrderId` pindah ke `toOrderId` dan order asal ditutup. */
        kind: 'SPLIT' | 'MERGE';
        /** Item yang dipindahkan (jumlah yang berpindah). */
        items: LineItem[];
        /** Item yang pindah sudah dikirim ke dapur (order tujuan berstatus "di dapur"). */
        sent: boolean;
        /** Status dapur order tujuan sesudah pemindahan (yang paling maju antara kedua order). */
        kitchen?: KitchenStatus;
      };
    }
  | {
      type: 'bill.printed';
      /** `items`: seluruh item pada tagihan; item terkunci sejak bill dicetak, jadi ini rincian final order. Tidak ada pada event lama. */
      payload: { orderId: string; total: number; items?: LineItem[] };
    }
  | {
      type: 'discount.applied';
      payload: {
        orderId: string;
        kind: 'MANUAL' | 'MEMBER' | 'COUPON';
        amount: number;
        percent: number;
        /** true jika member/kupon diverifikasi (scan barcode atau OTP) */
        verified: boolean;
        approverId?: string;
      };
    }
  | {
      type: 'payment.received';
      payload: { orderId: string; method: PaymentMethod; amount: number; tid?: string; approvalCode?: string };
    }
  | { type: 'payment.method_changed'; payload: { orderId: string; from: PaymentMethod; to: PaymentMethod } }
  | { type: 'receipt.printed'; payload: { orderId: string } }
  | {
      type: 'receipt.digital';
      /** Struk digital ditampilkan sebagai QR. `token`: 22 karakter base64url acak (128 bit) yang menjadi alamat struk di server. */
      payload: { orderId: string; token: string };
    }
  | { type: 'receipt.declined'; payload: { orderId: string; reason?: string } }
  | {
      type: 'void.approved';
      payload: { orderId: string; reasonCode: string; approverIds: string[]; amount: number };
    }
  | {
      type: 'refund.created';
      payload: { refundId: string; originalOrderId: string; amount: number; method: PaymentMethod; approverId: string };
    }
  | { type: 'drawer.opened'; payload: { orderId?: string } }
  | { type: 'printer.status'; payload: { state: PrinterState; source: 'device' | 'claim' } }
  | { type: 'printer.paper_claim'; payload: { active: boolean } }
  | {
      type: 'device.heartbeat';
      /** `status` hanya dikirim sensor: kondisi radar menurut firmware (ok, tidak ada frame, atau tertutup). */
      payload: { kind: 'sensor' | 'printer' | 'terminal' | 'kds'; status?: 'ok' | 'no_radar' | 'blocked' };
    }
  | {
      type: 'device.posture';
      /** Kondisi keamanan perangkat menurut aplikasi terbungkus Android. */
      payload: { autoTime: boolean; adb: boolean; devOptions: boolean; kiosk: boolean; rooted: boolean; appVersion: string };
    }
  | { type: 'shift.opened'; payload: { shiftId: string; openingCash: number } }
  | {
      type: 'cash.counted';
      /**
       * Hitungan buta kasir. `expected` dicatat untuk audit dan tidak ditampilkan ke kasir. `tracked`: terminal menghitungnya dari
       * pelacakan kas shift (aturan yang sama dengan hitungan ulang server); tidak ada pada shift yang dibuka sebelum pelacakan itu.
       */
      payload: { shiftId: string; counted: number; expected: number; tracked?: boolean };
    }
  | { type: 'shift.closed'; payload: { shiftId: string } }
  | {
      type: 'presence.session';
      payload: { start: number; end: number; peakMove: number; peakStatic: number; terminalId?: string };
    };

export type EventType = EventBody['type'];

export const EVENT_TYPES = [
  'order.created', 'order.sent_to_kitchen', 'order.table_changed', 'bill.hold_reason', 'order.items_moved', 'kitchen.status_changed', 'bill.printed', 'discount.applied',
  'payment.received', 'payment.method_changed', 'receipt.printed', 'receipt.digital', 'receipt.declined', 'void.approved',
  'refund.created', 'drawer.opened', 'printer.status', 'printer.paper_claim', 'device.heartbeat',
  'presence.session', 'shift.opened', 'cash.counted', 'shift.closed', 'device.posture',
] as const;

// Gagal kompilasi jika ada tipe event yang belum masuk daftar di atas.
type _AllTypesListed = EventType extends (typeof EVENT_TYPES)[number] ? true : never;
export const _allTypesListed: _AllTypesListed = true;

export function isEventType(v: unknown): v is EventType {
  return typeof v === 'string' && (EVENT_TYPES as readonly string[]).includes(v);
}

export interface Envelope {
  v: 1;
  id: string;
  deviceId: string;
  outletId: string;
  /** Naik satu per event per perangkat, tidak pernah diulang. */
  seq: number;
  /** epoch ms menurut jam perangkat */
  deviceTime: number;
  /** Selisih jam perangkat terhadap server (ms) pada sinkronisasi terakhir. Waktu terkoreksi = deviceTime − clockOffsetMs. */
  clockOffsetMs: number;
  actorId: string | null;
  prevHash: string;
  hash: string;
  /**
   * Tanda tangan ECDSA P-256 (r||s, base64url) atas string `hash`, dengan kunci perangkat.
   * Dibuat setelah hash sehingga tidak ikut dihitung dalam hash.
   */
  sig?: string;
}

export type PosEvent = Envelope & EventBody;
export type EventOf<T extends EventType> = Extract<PosEvent, { type: T }>;
export type NewEvent = EventBody & { deviceTime: number; actorId?: string | null; clockOffsetMs?: number };

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Batas isi satu event pesanan: server menolak (400) event yang melebihinya, dan 400 memacetkan sinkronisasi terminal, jadi terminal menegakkan batas yang sama. */
export const MAX_EVENT_LINES = 100;
export const MAX_LINE_QTY = 999;

/** Token struk digital: 22 karakter base64url (128 bit). */
export const RECEIPT_TOKEN = /^[A-Za-z0-9_-]{22}$/;

export const GENESIS_HASH = '0'.repeat(64);

/** Waktu event setelah koreksi jam perangkat. */
export function correctedTime(e: PosEvent): number {
  return e.deviceTime - e.clockOffsetMs;
}

/** JSON dengan kunci terurut, agar hash tidak bergantung pada urutan properti. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function hashEvent(e: DistOmit<PosEvent, 'hash'>): string {
  // JS murni agar sama persis di Node dan browser (POS web); hasilnya identik dengan SHA-256 biasa.
  return bytesToHex(sha256(utf8ToBytes(e.prevHash + canonicalJson(e))));
}

/** Pembuat rantai event untuk satu perangkat. */
export class EventChain {
  private seq = 0;
  private prevHash = GENESIS_HASH;

  constructor(
    readonly deviceId: string,
    readonly outletId: string,
    /** Melanjutkan rantai yang sudah ada (mis. setelah aplikasi dimulai ulang). */
    resume?: { seq: number; prevHash: string },
  ) {
    if (resume) {
      this.seq = resume.seq;
      this.prevHash = resume.prevHash;
    }
  }

  /** Posisi rantai saat ini, untuk disimpan agar bisa dilanjutkan. */
  get position(): { seq: number; prevHash: string } {
    return { seq: this.seq, prevHash: this.prevHash };
  }

  append(input: NewEvent): PosEvent {
    this.seq += 1;
    const { deviceTime, actorId, clockOffsetMs, ...body } = input;
    const unsigned = {
      v: 1 as const,
      id: `${this.deviceId}:${this.seq}`,
      deviceId: this.deviceId,
      outletId: this.outletId,
      seq: this.seq,
      deviceTime,
      clockOffsetMs: clockOffsetMs ?? 0,
      actorId: actorId ?? null,
      prevHash: this.prevHash,
      ...body,
    } as DistOmit<PosEvent, 'hash'>;
    const event = { ...unsigned, hash: hashEvent(unsigned) } as PosEvent;
    this.prevHash = event.hash;
    return event;
  }
}

export type IntegrityKind = 'SEQ_GAP' | 'SEQ_DUPLICATE' | 'HASH_MISMATCH' | 'CHAIN_BROKEN' | 'CLOCK_SKEW';

export interface IntegrityIssue {
  deviceId: string;
  seq: number;
  kind: IntegrityKind;
  detail: string;
}

export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Memeriksa rantai event satu perangkat. Event yang hilang terlihat sebagai lompatan seq,
 * event yang diubah terlihat sebagai hash tidak cocok, dan jam yang digeser sebagai clock skew.
 */
export function verifyChain(events: PosEvent[]): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let prev: PosEvent | undefined;
  for (const e of sorted) {
    const { hash, sig: _sig, ...rest } = e;
    if (hashEvent(rest as DistOmit<PosEvent, 'hash'>) !== hash) {
      issues.push({ deviceId: e.deviceId, seq: e.seq, kind: 'HASH_MISMATCH', detail: 'isi event tidak sesuai hash' });
    }
    if (Math.abs(e.clockOffsetMs) > MAX_CLOCK_SKEW_MS) {
      issues.push({
        deviceId: e.deviceId,
        seq: e.seq,
        kind: 'CLOCK_SKEW',
        detail: `jam perangkat bergeser ${Math.round(e.clockOffsetMs / 1000)} dtk`,
      });
    }
    if (prev) {
      if (e.seq === prev.seq) {
        issues.push({ deviceId: e.deviceId, seq: e.seq, kind: 'SEQ_DUPLICATE', detail: 'seq ganda' });
      } else if (e.seq !== prev.seq + 1) {
        issues.push({
          deviceId: e.deviceId,
          seq: e.seq,
          kind: 'SEQ_GAP',
          detail: `seq ${prev.seq + 1}..${e.seq - 1} hilang`,
        });
      } else if (e.prevHash !== prev.hash) {
        issues.push({ deviceId: e.deviceId, seq: e.seq, kind: 'CHAIN_BROKEN', detail: 'prevHash tidak cocok' });
      }
    }
    prev = e;
  }
  return issues;
}

/** Event untuk satu order (termasuk refund terhadap order itu). */
export function orderIdOf(e: PosEvent): string | undefined {
  switch (e.type) {
    case 'refund.created':
      return e.payload.originalOrderId;
    case 'drawer.opened':
      return e.payload.orderId;
    case 'order.items_moved':
      return e.payload.fromOrderId;
    case 'order.created':
    case 'order.sent_to_kitchen':
    case 'order.table_changed':
    case 'bill.hold_reason':
    case 'kitchen.status_changed':
    case 'bill.printed':
    case 'discount.applied':
    case 'payment.received':
    case 'payment.method_changed':
    case 'receipt.printed':
    case 'receipt.digital':
    case 'receipt.declined':
    case 'void.approved':
      return e.payload.orderId;
    default:
      return undefined;
  }
}
