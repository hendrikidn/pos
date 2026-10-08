import type { Queryable } from './db/driver';

const num = (v: unknown) => Number(v);

/** Pesanan web outlet untuk GuardService: yang diterima sejak `fromMs` dan yang disebut event tautan. */
export async function webOrderFacts(q: Queryable, outletId: string, fromMs: number, linkedIds: number[]) {
  const rows = (await q.query<{ id: string; status: 'NEW' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED'; estimated_total: string; decided_at_ms: number | null }>(
    'select id, status, estimated_total, decided_at_ms from web_order where outlet_id = $1 and ((status = \'ACCEPTED\' and decided_at_ms >= $2) or id = any($3::bigint[]))', [outletId, fromMs, linkedIds],
  )).rows;
  return rows.map((r) => ({ id: num(r.id), status: r.status, estimatedTotal: num(r.estimated_total), decidedAtMs: r.decided_at_ms === null ? null : num(r.decided_at_ms) }));
}
