import type { Queryable } from './db/driver';

const num = (v: unknown) => Number(v);

/** Kiriman yang belum diterima lebih lama dari ini menjadi temuan. */
export const TRANSFER_STALE_MS = 24 * 3_600_000;

/** Temuan transfer untuk GuardService: kiriman menggantung (R40) dan selisih jumlah (R41), 14 hari terakhir. */
export async function transferHits(q: Queryable, outletId: string, now: number) {
  const since = now - 14 * 86_400_000;
  const rows = (await q.query<{ id: string; from_outlet: string; to_outlet: string; status: string; sent_by: string; sent_at_ms: number; received_by: string | null; received_at_ms: number | null; short: boolean }>(
    `select id, from_outlet, to_outlet, status, sent_by, sent_at_ms, received_by, received_at_ms, short from stock_transfer
     where (from_outlet = $1 or to_outlet = $1) and sent_at_ms >= $2`, [outletId, since],
  )).rows;
  const hits: { rule: 'R40' | 'R41'; key: string; transferId: number; at: number; actor: string; note: string; terminal: null }[] = [];
  for (const t of rows) {
    const id = num(t.id);
    if (t.status === 'SENT' && now - num(t.sent_at_ms) > TRANSFER_STALE_MS) {
      hits.push({ rule: 'R40', key: `R40:${id}`, transferId: id, at: num(t.sent_at_ms) + TRANSFER_STALE_MS, actor: t.sent_by, terminal: null, note: `transfer #${id} dari ${t.from_outlet} ke ${t.to_outlet} dikirim lebih dari 24 jam lalu dan belum diterima` });
    }
    if (t.status === 'RECEIVED' && t.short) {
      const lines = (await q.query<{ ingredient_id: string; qty_sent: number; qty_received: number; unit_cost: string }>('select ingredient_id, qty_sent, qty_received, unit_cost from stock_transfer_line where transfer_id = $1 and qty_received < qty_sent', [id])).rows;
      const value = lines.reduce((s, l) => s + Math.round((l.qty_sent - l.qty_received) * num(l.unit_cost)), 0);
      hits.push({ rule: 'R41', key: `R41:${id}`, transferId: id, at: num(t.received_at_ms ?? t.sent_at_ms), actor: t.received_by ?? t.sent_by, terminal: null, note: `transfer #${id} diterima kurang dari yang dikirim: ${lines.map((l) => `${l.ingredient_id} ${l.qty_sent}→${l.qty_received}`).join(', ')} (senilai Rp ${value.toLocaleString('id-ID')})` });
    }
  }
  return hits;
}
