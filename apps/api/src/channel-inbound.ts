import { correctedTime, type EventOf, type PosEvent } from '@pos/events';

/** Gerbang pesanan online yang murni (tanpa database): pemeriksaan isi pesanan dari platform, kunci pemetaan menu, dan temuan R54-R55. */

export const CHANNELS = ['GOFOOD', 'GRABFOOD', 'SHOPEEFOOD'] as const;
export type Channel = (typeof CHANNELS)[number];
export const REF_RE = /^[A-Za-z0-9._-]{3,30}$/;
export const MAX_ITEMS = 50;
/** Pesanan baru yang tidak ditanggapi kasir sekian lama kedaluwarsa. */
export const INBOUND_EXPIRE_MS = 2 * 3_600_000;
/** R55: pesanan diterima tetapi order kasirnya tidak dibuat dalam waktu ini. */
export const INBOUND_LINK_GRACE_MS = 15 * 60_000;

export interface InboundItem { externalId?: string; key: string; name: string; qty: number; unitPrice: number; note?: string }

/** Kunci pemetaan: id menu di platform bila ada, kalau tidak nama yang dirapikan (huruf kecil, spasi tunggal). */
export const itemKey = (externalId: unknown, name: string): string => (typeof externalId === 'string' && externalId.trim() ? `id:${externalId.trim()}` : `nama:${name.trim().toLowerCase().replace(/\s+/g, ' ')}`);

export type InboundCheck = { ok: true; value: { ref: string; total: number; customerName: string | null; note: string | null; placedAt: number | null; items: InboundItem[] } } | { ok: false; message: string };

/** Memeriksa isi pesanan yang dikirim platform (atau perantara). Semua angka bilangan bulat rupiah; nama dan catatan dipangkas. */
export function checkInbound(body: unknown): InboundCheck {
  const b = body as Record<string, unknown> | null;
  if (typeof b !== 'object' || b === null) return { ok: false, message: 'isi pesanan tidak valid' };
  if (typeof b['ref'] !== 'string' || !REF_RE.test(b['ref'])) return { ok: false, message: 'ref: nomor pesanan 3–30 karakter (huruf, angka, titik, - atau _)' };
  if (!Number.isInteger(b['total']) || (b['total'] as number) < 0 || (b['total'] as number) > 20_000_000) return { ok: false, message: 'total harus bilangan bulat rupiah 0–20.000.000' };
  if (!Array.isArray(b['items']) || b['items'].length < 1 || b['items'].length > MAX_ITEMS) return { ok: false, message: `items wajib berisi 1–${MAX_ITEMS} baris` };
  const items: InboundItem[] = [];
  for (const raw of b['items'] as Record<string, unknown>[]) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, message: 'baris pesanan tidak valid' };
    const name = typeof raw['name'] === 'string' ? raw['name'].trim().slice(0, 80) : '';
    if (!name) return { ok: false, message: 'setiap baris wajib bernama' };
    if (!Number.isInteger(raw['qty']) || (raw['qty'] as number) < 1 || (raw['qty'] as number) > 99) return { ok: false, message: `jumlah "${name}" harus 1–99` };
    if (!Number.isInteger(raw['unitPrice']) || (raw['unitPrice'] as number) < 0 || (raw['unitPrice'] as number) > 10_000_000) return { ok: false, message: `harga "${name}" tidak valid` };
    const externalId = typeof raw['externalId'] === 'string' && raw['externalId'].trim() ? raw['externalId'].trim().slice(0, 64) : undefined;
    const note = typeof raw['note'] === 'string' && raw['note'].trim() ? raw['note'].trim().slice(0, 140) : undefined;
    items.push({ ...(externalId ? { externalId } : {}), key: itemKey(externalId, name), name, qty: raw['qty'] as number, unitPrice: raw['unitPrice'] as number, ...(note ? { note } : {}) });
  }
  const placed = b['placedAt'] === undefined || b['placedAt'] === null ? null : typeof b['placedAt'] === 'number' ? b['placedAt'] : Date.parse(String(b['placedAt']));
  if (placed !== null && !Number.isFinite(placed)) return { ok: false, message: 'placedAt tidak valid' };
  const customerName = typeof b['customerName'] === 'string' && b['customerName'].trim() ? b['customerName'].trim().slice(0, 60) : null;
  const note = typeof b['note'] === 'string' && b['note'].trim() ? b['note'].trim().slice(0, 200) : null;
  return { ok: true, value: { ref: b['ref'], total: b['total'] as number, customerName, note, placedAt: placed, items } };
}

export interface InboundFacts { id: number; channel: Channel; ref: string; status: string; decidedAtMs: number | null; items: { menuId: string | null; qty: number; name: string }[] }
export interface ChannelHit { rule: 'R54' | 'R55'; key: string; at: number; actor: string | null; terminalId: string | null; orderId: string | null; note: string }

const tally = (rows: { id: string; qty: number }[]) => { const m = new Map<string, number>(); for (const r of rows) m.set(r.id, (m.get(r.id) ?? 0) + r.qty); return m; };

/**
 * Temuan pesanan platform yang masuk lewat gerbang:
 *  - R55: diterima di kasir tetapi order online tidak pernah dibuat dalam 15 menit.
 *  - R54: isi order kasir (tagihan terakhir) berbeda dari pesanan platform: menu dihapus, ditambah, atau jumlahnya diubah setelah diterima.
 */
export function inboundHits(inbound: InboundFacts[], events: PosEvent[], now: number, fromMs: number): ChannelHit[] {
  const t = correctedTime;
  const links = new Map<string, EventOf<'order.channel_linked'>>();
  for (const e of events) if (e.type === 'order.channel_linked') links.set(`${e.payload.channel}:${e.payload.ref.toLowerCase()}`, e);
  const bills = new Map<string, EventOf<'bill.printed'>>();
  for (const e of events) if (e.type === 'bill.printed') bills.set(e.payload.orderId, e);
  // Order yang digabung atau dipecah bayar isinya memang berpindah; perbandingan isi tidak berlaku untuknya.
  const moved = new Set<string>();
  for (const e of events) if (e.type === 'order.items_moved') { moved.add(e.payload.fromOrderId); moved.add(e.payload.toOrderId); }
  const voided = new Set(events.filter((e) => e.type === 'void.approved').map((e) => (e as EventOf<'void.approved'>).payload.orderId));
  const hits: ChannelHit[] = [];
  for (const o of inbound) {
    if (o.status !== 'ACCEPTED') continue;
    const link = links.get(`${o.channel}:${o.ref.toLowerCase()}`);
    if (!link) {
      const due = (o.decidedAtMs ?? 0) + INBOUND_LINK_GRACE_MS;
      if (o.decidedAtMs !== null && now >= due) hits.push({ rule: 'R55', key: `R55:${o.id}`, at: due, actor: null, terminalId: null, orderId: null, note: `pesanan ${o.channel} ${o.ref} diterima di kasir tetapi order onlinenya tidak pernah dibuat` });
      continue;
    }
    const bill = bills.get(link.payload.orderId);
    if (!bill || voided.has(link.payload.orderId) || moved.has(link.payload.orderId) || !bill.payload.items) continue;
    const platform = tally(o.items.filter((i) => i.menuId).map((i) => ({ id: i.menuId!, qty: i.qty })));
    const pos = tally(bill.payload.items.map((i) => ({ id: i.itemId, qty: i.qty })));
    const diffs: string[] = [];
    for (const id of new Set([...platform.keys(), ...pos.keys()])) if ((platform.get(id) ?? 0) !== (pos.get(id) ?? 0)) diffs.push(`${id} platform ${platform.get(id) ?? 0}, kasir ${pos.get(id) ?? 0}`);
    if (diffs.length > 0) {
      hits.push({ rule: 'R54', key: `R54:${o.id}`, at: t(bill), actor: link.actorId ?? null, terminalId: link.deviceId, orderId: link.payload.orderId, note: `isi order kasir ${link.payload.orderId} berbeda dari pesanan ${o.channel} ${o.ref}: ${diffs.join('; ')}` });
    }
  }
  return hits.filter((h) => h.at >= fromMs);
}
