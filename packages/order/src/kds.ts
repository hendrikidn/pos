import { correctedTime, type KitchenStatus, type LineItem, type OrderType, type PosEvent } from '@pos/events';

/** Tiket yang terakhir dikirim lebih lama dari ini tidak ditampilkan lagi (sisa dari shift kemarin). */
export const KDS_HISTORY_MS = 12 * 3_600_000;
/** Tiket yang dibatalkan tetap terlihat sebentar agar dapur berhenti memasaknya. */
export const KDS_VOID_VISIBLE_MS = 15 * 60_000;

export interface KdsLine {
  name: string;
  options: string[];
  note?: string;
  qty: number;
  /** Ditambahkan sesudah status tiket terakhir diubah (item susulan). */
  fresh: boolean;
}

export interface KdsTicket {
  orderId: string;
  /** Nomor tampilan (bagian akhir id order). */
  ref: string;
  type: OrderType | null;
  table: string | null;
  status: KitchenStatus | 'NEW';
  /** Ada item susulan yang belum disentuh dapur. */
  hasNew: boolean;
  /** Kapan item pertama dikirim ke dapur (penghitung waktu tiket). */
  firstSentAt: number;
  statusAt: number | null;
  lines: KdsLine[];
  /** Tiket dari terminal lama: rincian item tidak tersedia. */
  noDetail: boolean;
}

export interface KdsVoided {
  orderId: string;
  ref: string;
  type: OrderType | null;
  table: string | null;
  at: number;
  lines: KdsLine[];
}

export interface KdsBoard {
  generatedAt: number;
  tickets: KdsTicket[];
  voided: KdsVoided[];
}

interface Line {
  name: string;
  options: string[];
  note?: string;
  qty: number;
  addedAt: number;
}

interface State {
  orderId: string;
  type: OrderType | null;
  table: string | null;
  lines: Map<string, Line>;
  status: KitchenStatus | null;
  statusAt: number | null;
  firstSentAt: number | null;
  noDetail: boolean;
  voidedAt: number | null;
  voidedLines: Line[];
  merged: boolean;
}

const lineKey = (l: Pick<LineItem, 'itemId' | 'note'> & { options?: { name: string }[] }) =>
  JSON.stringify([l.itemId, (l.options ?? []).map((o) => o.name).sort(), l.note ?? '']);

const toKdsLine = (l: Line, statusAt: number | null): KdsLine => ({
  name: l.name,
  options: l.options,
  ...(l.note ? { note: l.note } : {}),
  qty: l.qty,
  fresh: statusAt !== null && l.addedAt > statusAt,
});

/**
 * Papan tiket dapur dari event POS. Murni: sama dipakai server (untuk layar dapur) dan pengujian.
 *
 * Aturan:
 *  - Tiket = satu order; isinya hanya item yang SUDAH dikirim ke dapur (`order.sent_to_kitchen`), dikurangi/ditambah oleh
 *    pisah bill dan gabung order (hanya bagian yang sudah terkirim ikut pindah).
 *  - Status = status dapur terakhir (`kitchen.status_changed`, dari terminal atau layar dapur); belum ada = NEW.
 *  - Item susulan sesudah status berubah ditandai `fresh`; bila tiket sudah READY, statusnya kembali COOKING.
 *  - SERVED menutup tiket; kiriman berikutnya untuk order yang sama membuka tiket baru berisi item susulan saja.
 *  - Order yang di-void muncul di `voided` sebentar, tidak lagi di `tickets`.
 */
export function buildKitchenBoard(input: { events: PosEvent[]; now: number }): KdsBoard {
  const { now } = input;
  const events = [...input.events].sort((a, b) => correctedTime(a) - correctedTime(b) || a.deviceId.localeCompare(b.deviceId) || a.seq - b.seq);
  const states = new Map<string, State>();
  const get = (orderId: string): State => {
    let s = states.get(orderId);
    if (!s) {
      s = { orderId, type: null, table: null, lines: new Map(), status: null, statusAt: null, firstSentAt: null, noDetail: false, voidedAt: null, voidedLines: [], merged: false };
      states.set(orderId, s);
    }
    return s;
  };
  const add = (s: State, key: string, l: Omit<Line, 'qty' | 'addedAt'>, qty: number, addedAt: number) => {
    const have = s.lines.get(key);
    if (have) {
      have.qty += qty;
      have.addedAt = Math.max(have.addedAt, addedAt);
    } else s.lines.set(key, { ...l, qty, addedAt });
  };

  for (const e of events) {
    const t = correctedTime(e);
    switch (e.type) {
      case 'order.created': {
        const s = get(e.payload.orderId);
        s.type = e.payload.orderType;
        if (e.payload.tableNo) s.table = e.payload.tableNo;
        break;
      }
      case 'order.table_changed':
        get(e.payload.orderId).table = e.payload.to;
        break;
      case 'order.sent_to_kitchen': {
        const s = get(e.payload.orderId);
        if (s.status === 'SERVED') {
          s.status = null;
          s.statusAt = null;
          s.firstSentAt = null;
        } else if (s.status === 'READY') s.status = 'COOKING';
        s.firstSentAt ??= t;
        const items = e.payload.items;
        if (!items) s.noDetail = true;
        else for (const l of items) add(s, lineKey(l), { name: l.name, options: (l.options ?? []).map((o) => o.name), ...(l.note ? { note: l.note } : {}) }, l.qty, t);
        break;
      }
      case 'kitchen.status_changed': {
        const s = get(e.payload.orderId);
        if (s.firstSentAt === null && s.lines.size === 0 && !s.noDetail) break;
        s.status = e.payload.status;
        s.statusAt = t;
        if (e.payload.status === 'SERVED') {
          s.lines.clear();
          s.noDetail = false;
          s.firstSentAt = null;
        }
        break;
      }
      case 'void.approved': {
        const s = get(e.payload.orderId);
        if (s.voidedAt === null) {
          s.voidedAt = t;
          s.voidedLines = [...s.lines.values()].map((l) => ({ ...l }));
        }
        break;
      }
      case 'order.items_moved': {
        const p = e.payload;
        const from = get(p.fromOrderId);
        const to = get(p.toOrderId);
        if (p.kind === 'SPLIT') {
          for (const l of p.items) {
            const moved = l.sentQty ?? (p.sent ? l.qty : 0);
            if (moved <= 0) continue;
            const key = lineKey(l);
            const src = from.lines.get(key);
            const take = src ? Math.min(moved, src.qty) : moved;
            if (src) {
              src.qty -= take;
              if (src.qty <= 0) from.lines.delete(key);
            }
            add(to, key, { name: l.name, options: (l.options ?? []).map((o) => o.name), ...(l.note ? { note: l.note } : {}) }, take, src?.addedAt ?? t);
          }
          if (to.lines.size > 0) {
            to.firstSentAt ??= from.firstSentAt ?? t;
            // Status asal menurut papan lebih tepercaya daripada `kitchen` di event: terminal tidak tahu status yang diubah dari layar dapur.
            const inherited = from.status ?? p.kitchen ?? null;
            if (inherited && to.status === null) {
              to.status = inherited;
              to.statusAt = from.statusAt ?? t;
            }
          }
        } else {
          for (const [key, l] of from.lines) add(to, key, l, l.qty, l.addedAt);
          if (from.lines.size > 0) {
            to.firstSentAt = Math.min(to.firstSentAt ?? Infinity, from.firstSentAt ?? Infinity);
            if (!Number.isFinite(to.firstSentAt)) to.firstSentAt = t;
            if (to.status === null && from.status !== null) {
              to.status = from.status;
              to.statusAt = from.statusAt;
            }
          }
          to.noDetail ||= from.noDetail;
          from.lines.clear();
          from.noDetail = false;
          from.merged = true;
        }
        break;
      }
      default:
        break;
    }
  }

  const tickets: KdsTicket[] = [];
  const voided: KdsVoided[] = [];
  for (const s of states.values()) {
    const ref = s.orderId.split('-').pop() ?? s.orderId;
    if (s.voidedAt !== null) {
      if (s.voidedLines.length > 0 && now - s.voidedAt <= KDS_VOID_VISIBLE_MS) {
        voided.push({ orderId: s.orderId, ref, type: s.type, table: s.table, at: s.voidedAt, lines: s.voidedLines.map((l) => toKdsLine(l, null)) });
      }
      continue;
    }
    if (s.merged || s.status === 'SERVED' || s.firstSentAt === null) continue;
    if (s.lines.size === 0 && !s.noDetail) continue;
    if (now - s.firstSentAt > KDS_HISTORY_MS) continue;
    const lines = [...s.lines.values()].map((l) => toKdsLine(l, s.statusAt));
    tickets.push({
      orderId: s.orderId, ref, type: s.type, table: s.table, status: s.status ?? 'NEW',
      hasNew: lines.some((l) => l.fresh), firstSentAt: s.firstSentAt, statusAt: s.statusAt, lines, noDetail: s.noDetail,
    });
  }
  tickets.sort((a, b) => a.firstSentAt - b.firstSentAt || a.orderId.localeCompare(b.orderId));
  voided.sort((a, b) => b.at - a.at);
  return { generatedAt: now, tickets, voided };
}
