import { correctedTime, type EventOf, type PosEvent } from '@pos/events';
import { MAX_NOTE_LENGTH, resolveSelection, type ChosenOption, type ModifierGroup } from '@pos/order';

/** Aturan toko web yang murni (tanpa database): pemeriksaan keranjang dari pelanggan dan temuan R45-R47. */

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;
export const PHONE_RE = /^[0-9 +()-]{8,20}$/;

/** Nomor telepon sah: karakter yang wajar dan 8–15 angka (tanda baca saja tidak cukup). */
export function validPhone(s: string): boolean {
  const digits = s.replace(/\D/g, '').length;
  return PHONE_RE.test(s) && digits >= 8 && digits <= 15;
}

/** Bentuk baku untuk membandingkan nomor: hanya angka, awalan 62 (kode negara) diganti 0. "+62 812-3456" dan "0812 3456" sama. */
export function phoneKey(s: string): string {
  const d = s.replace(/\D/g, '');
  return d.startsWith('62') ? `0${d.slice(2)}` : d;
}
export const WEB_EXPIRE_MS = 30 * 60_000;
export const MAX_LINES = 30;
export const MAX_LINE_QTY = 20;
/** Batas nilai satu pesanan web (estimasi): pesanan besar harus lewat kasir. */
export const MAX_WEB_TOTAL = 3_000_000;
/** Pesanan diterima tetapi order kasirnya tidak dibuat dalam waktu ini menjadi temuan (R45). */
export const LINK_GRACE_MS = 15 * 60_000;
/** Order kasir dari pesanan web yang belum dibayar sekian lama setelah diterima menjadi temuan (R46). */
export const UNPAID_AFTER_MS = 3 * 3_600_000;

export interface MenuRow { id: string; name: string; price: number; modifierGroups: ModifierGroup[] }

export interface WebLine { itemId: string; name: string; qty: number; unitPrice: number; options: ChosenOption[]; note?: string }

export type CartResult = { ok: true; lines: WebLine[] } | { ok: false; message: string };

/**
 * Memeriksa keranjang dari pelanggan terhadap menu server. Harga TIDAK pernah diambil dari pelanggan: hanya id menu, jumlah, id opsi, dan
 * catatan; nama dan harga disalin dari menu. Baris dengan menu dan pilihan yang sama digabung.
 */
export function checkCart(input: unknown, menu: Map<string, MenuRow>): CartResult {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, message: 'keranjang kosong' };
  if (input.length > MAX_LINES) return { ok: false, message: `maksimal ${MAX_LINES} baris pesanan` };
  const lines: WebLine[] = [];
  for (const raw of input as Record<string, unknown>[]) {
    if (typeof raw !== 'object' || raw === null || typeof raw['itemId'] !== 'string') return { ok: false, message: 'baris pesanan tidak valid' };
    const item = menu.get(raw['itemId']);
    if (!item) return { ok: false, message: 'ada menu yang sudah tidak tersedia; muat ulang halaman' };
    const qty = raw['qty'];
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > MAX_LINE_QTY) return { ok: false, message: `jumlah "${item.name}" harus 1–${MAX_LINE_QTY}` };
    const optionIds = raw['options'] === undefined ? [] : raw['options'];
    if (!Array.isArray(optionIds) || !optionIds.every((o) => typeof o === 'string')) return { ok: false, message: `pilihan "${item.name}" tidak valid` };
    const sel = resolveSelection(item.modifierGroups, optionIds as string[]);
    if (!sel.ok) return { ok: false, message: `${item.name}: ${sel.message}` };
    let note: string | undefined;
    if (raw['note'] !== undefined && raw['note'] !== null && raw['note'] !== '') {
      if (typeof raw['note'] !== 'string' || raw['note'].trim().length > MAX_NOTE_LENGTH) return { ok: false, message: `catatan "${item.name}" maksimal ${MAX_NOTE_LENGTH} karakter` };
      note = raw['note'].trim() || undefined;
    }
    const key = (l: { itemId: string; options: ChosenOption[]; note?: string }) => `${l.itemId}|${l.options.map((o) => o.optionId).join(',')}|${l.note ?? ''}`;
    const line: WebLine = { itemId: item.id, name: item.name, qty, unitPrice: item.price + sel.extra, options: sel.options, ...(note ? { note } : {}) };
    const same = lines.find((l) => key(l) === key(line));
    if (same) {
      same.qty += qty;
      if (same.qty > MAX_LINE_QTY) return { ok: false, message: `jumlah "${item.name}" maksimal ${MAX_LINE_QTY}` };
    } else lines.push(line);
  }
  return { ok: true, lines };
}

export interface WebOrderFacts { id: number; status: 'NEW' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED'; estimatedTotal: number; decidedAtMs: number | null }

/**
 * Nasib order kasir dari event: yang di-void, yang digabung ke order lain (tidak akan pernah dibayar sendiri), dan pembayaran bersih (setelah
 * refund) satu order BESERTA pecahannya (pisah bill memindahkan sebagian item ke order baru yang dibayar sendiri).
 */
export function orderFlows(events: PosEvent[]) {
  const t = correctedTime;
  const voided = new Map<string, number>();
  const mergedAway = new Set<string>();
  const children = new Map<string, string[]>();
  const own = new Map<string, { total: number; last: number }>();
  for (const e of events) {
    if (e.type === 'void.approved' && !voided.has(e.payload.orderId)) voided.set(e.payload.orderId, t(e));
    else if (e.type === 'order.items_moved') {
      if (e.payload.kind === 'MERGE') mergedAway.add(e.payload.fromOrderId);
      else (children.get(e.payload.fromOrderId) ?? children.set(e.payload.fromOrderId, []).get(e.payload.fromOrderId)!).push(e.payload.toOrderId);
    } else if (e.type === 'payment.received') {
      const p = own.get(e.payload.orderId) ?? { total: 0, last: 0 };
      p.total += e.payload.amount;
      p.last = Math.max(p.last, t(e));
      own.set(e.payload.orderId, p);
    } else if (e.type === 'refund.created') {
      const p = own.get(e.payload.originalOrderId) ?? { total: 0, last: 0 };
      p.total -= e.payload.amount;
      own.set(e.payload.originalOrderId, p);
    }
  }
  const family = (id: string, seen = new Set<string>()): { total: number; last: number } => {
    if (seen.has(id)) return { total: 0, last: 0 };
    seen.add(id);
    const o = own.get(id) ?? { total: 0, last: 0 };
    let total = o.total;
    let last = o.last;
    for (const c of children.get(id) ?? []) {
      if (voided.has(c)) continue;
      const f = family(c, seen);
      total += f.total;
      last = Math.max(last, f.last);
    }
    return { total, last };
  };
  return { voided, mergedAway, family };
}

export interface WebHit { rule: 'R45' | 'R46' | 'R47'; key: string; at: number; actor: string | null; terminalId: string | null; orderId: string | null; note: string }

const rp = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;

/**
 * Temuan pesanan toko web dari event kasir dan data pesanan:
 *  - R45: pesanan diterima tetapi order kasirnya tidak pernah dibuat dalam 15 menit; tautan ke pesanan yang tidak ada atau belum diterima;
 *    satu pesanan ditautkan ke lebih dari satu order.
 *  - R46: order kasir dari pesanan web di-void, atau belum dibayar 3 jam setelah diterima (uang pelanggan bisa saja masuk kantong).
 *  - R47: dibayar jauh di bawah nilai pesanan (selisih lebih dari 10% dan Rp 1.000): item dihapus atau diskon besar setelah diterima.
 * `webOrders` harus memuat semua pesanan yang ditautkan oleh event-event itu.
 */
export function webOrderHits(webOrders: WebOrderFacts[], events: PosEvent[], now: number, fromMs: number): WebHit[] {
  const t = correctedTime;
  const byId = new Map(webOrders.map((w) => [w.id, w]));
  const links = events.filter((e): e is EventOf<'order.web_linked'> => e.type === 'order.web_linked').sort((a, b) => t(a) - t(b) || a.deviceId.localeCompare(b.deviceId) || a.seq - b.seq);
  const { voided, mergedAway, family } = orderFlows(events);
  const hits: WebHit[] = [];
  const linkedTo = new Map<number, EventOf<'order.web_linked'>[]>();
  for (const l of links) (linkedTo.get(l.payload.webOrderId) ?? linkedTo.set(l.payload.webOrderId, []).get(l.payload.webOrderId)!).push(l);

  for (const [wid, ls] of linkedTo) {
    const w = byId.get(wid);
    const first = ls[0]!;
    const live = ls.filter((l) => !voided.has(l.payload.orderId));
    if (!w || w.status !== 'ACCEPTED') {
      hits.push({ rule: 'R45', key: `R45:link:${wid}`, at: t(first), actor: first.actorId ?? null, terminalId: first.deviceId, orderId: first.payload.orderId, note: w ? `order kasir ditautkan ke pesanan web #${wid} yang berstatus ${w.status}, bukan diterima` : `order kasir ditautkan ke pesanan web #${wid} yang tidak ada di outlet ini` });
      continue;
    }
    if (live.length > 1) {
      const second = live[1]!;
      hits.push({ rule: 'R45', key: `R45:dup:${wid}`, at: t(second), actor: second.actorId ?? null, terminalId: second.deviceId, orderId: second.payload.orderId, note: `pesanan web #${wid} ditautkan ke ${live.length} order kasir sekaligus (${live.map((l) => l.payload.orderId).join(', ')})` });
    }
    for (const l of ls) {
      const oid = l.payload.orderId;
      const v = voided.get(oid);
      if (v !== undefined) {
        hits.push({ rule: 'R46', key: `R46:void:${oid}`, at: v, actor: l.actorId ?? null, terminalId: l.deviceId, orderId: oid, note: `order kasir ${oid} dari pesanan web #${wid} (estimasi ${rp(w.estimatedTotal)}) di-void` });
        continue;
      }
      if (mergedAway.has(oid)) continue; // digabung ke order lain: nilainya dibayar lewat order tujuan
      const p = family(oid);
      if (p.total <= 0) {
        const due = (w.decidedAtMs ?? t(l)) + UNPAID_AFTER_MS;
        if (now >= due) hits.push({ rule: 'R46', key: `R46:unpaid:${oid}`, at: due, actor: l.actorId ?? null, terminalId: l.deviceId, orderId: oid, note: `order kasir ${oid} dari pesanan web #${wid} (estimasi ${rp(w.estimatedTotal)}) belum dibayar lebih dari 3 jam setelah diterima` });
      } else if (p.total < w.estimatedTotal - Math.max(1000, Math.round(w.estimatedTotal * 0.1))) {
        hits.push({ rule: 'R47', key: `R47:${oid}`, at: p.last, actor: l.actorId ?? null, terminalId: l.deviceId, orderId: oid, note: `order kasir ${oid} dari pesanan web #${wid} dibayar ${rp(p.total)}, jauh di bawah nilai pesanan ${rp(w.estimatedTotal)}` });
      }
    }
  }
  for (const w of webOrders) {
    if (w.status !== 'ACCEPTED' || w.decidedAtMs === null || linkedTo.has(w.id)) continue;
    const due = w.decidedAtMs + LINK_GRACE_MS;
    if (now >= due) hits.push({ rule: 'R45', key: `R45:nolink:${w.id}`, at: due, actor: null, terminalId: null, orderId: null, note: `pesanan web #${w.id} (${rp(w.estimatedTotal)}) diterima di kasir tetapi order kasirnya tidak pernah dibuat` });
  }
  return hits.filter((h) => h.at >= fromMs);
}
