import { correctedTime, type LineItem, type PosEvent } from '@pos/events';

/** Serah-terima yang belum diambil lebih lama dari ini dianggap kedaluwarsa dan tidak ditawarkan lagi. */
export const HANDOFF_MAX_AGE_MS = 12 * 3_600_000;
/** Klaim yang tidak diselesaikan (terminal mati di tengah jalan) dilepas setelah ini agar terminal lain bisa mengambil. */
export const HANDOFF_CLAIM_TTL_MS = 10 * 60_000;

/** Hasil serah-terima (diambil atau ditarik) tetap dilaporkan sekian lama untuk terminal asal. */
export const HANDOFF_RESULT_KEEP_MS = 48 * 3_600_000;

export type HandoffState = 'PENDING' | 'ACCEPTED' | 'RECLAIMED';

export interface HandoffEntry {
  orderId: string;
  /** Terminal yang menyerahkan, dan nomor urut event `order.handed_off`-nya (identitas serah-terima ini; satu order bisa diserahkan lagi setelah ditarik). */
  fromDeviceId: string;
  handoffSeq: number;
  orderType: 'DINE_IN' | 'TAKE_AWAY';
  tableNo?: string;
  items: LineItem[];
  /** Jam yang sudah dikoreksi. */
  at: number;
  state: HandoffState;
  /** Terminal yang mengambil (hanya ACCEPTED). */
  by?: string;
}

/**
 * Daftar serah-terima order dari event semua terminal. Murni: dipakai server dan pengujian.
 *  - `order.handed_off` membuka serah-terima (PENDING); menyerahkan lagi order yang sama setelah ditarik membuka yang baru.
 *  - `order.handoff_reclaimed` dari terminal asal menutupnya (RECLAIMED).
 *  - `order.items_moved` MERGE dari order itu yang dicatat terminal lain menutupnya (ACCEPTED, `by` = terminal itu).
 */
export function buildHandoffs(input: { events: PosEvent[]; now: number }): HandoffEntry[] {
  const events = [...input.events].sort((a, b) => correctedTime(a) - correctedTime(b) || a.deviceId.localeCompare(b.deviceId) || a.seq - b.seq);
  const latest = new Map<string, HandoffEntry>();
  const all: HandoffEntry[] = [];
  for (const e of events) {
    if (e.type === 'order.handed_off') {
      const entry: HandoffEntry = {
        orderId: e.payload.orderId, fromDeviceId: e.deviceId, handoffSeq: e.seq, orderType: e.payload.orderType,
        ...(e.payload.tableNo ? { tableNo: e.payload.tableNo } : {}), items: e.payload.items, at: correctedTime(e), state: 'PENDING',
      };
      latest.set(e.payload.orderId, entry);
      all.push(entry);
    } else if (e.type === 'order.handoff_reclaimed') {
      const h = latest.get(e.payload.orderId);
      if (h && h.state === 'PENDING' && h.fromDeviceId === e.deviceId) h.state = 'RECLAIMED';
    } else if (e.type === 'order.items_moved' && e.payload.kind === 'MERGE') {
      const h = latest.get(e.payload.fromOrderId);
      if (h && h.state === 'PENDING' && h.fromDeviceId !== e.deviceId) {
        h.state = 'ACCEPTED';
        h.by = e.deviceId;
      }
    }
  }
  // Yang masih menunggu kedaluwarsa setelah 12 jam; yang sudah selesai tetap dilaporkan lebih lama agar terminal asal yang lama offline tetap tahu hasilnya.
  return all.filter((h) => input.now - h.at <= (h.state === 'PENDING' ? HANDOFF_MAX_AGE_MS : HANDOFF_RESULT_KEEP_MS));
}
