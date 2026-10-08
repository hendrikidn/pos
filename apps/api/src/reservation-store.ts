import type { Queryable } from './db/driver';

const num = (v: unknown) => Number(v);

/** Jumlah uang muka yang sudah dipakai sebagai pembayaran, per reservasi (dari event, bukan kolom yang bisa diubah). */
export async function appliedDeposits(q: Queryable, outletId: string, ids?: number[]): Promise<Map<number, number>> {
  const rows = (await q.query<{ rid: string; total: string }>(
    `select payload->>'reservationId' as rid, sum((payload->>'amount')::numeric) as total from event
     where outlet_id = $1 and type = 'payment.received' and payload->>'method' = 'DEPOSIT'
       and ($2::text[] is null or payload->>'reservationId' = any($2::text[])) group by 1`,
    [outletId, ids ? ids.map(String) : null],
  )).rows;
  return new Map(rows.map((r) => [num(r.rid), num(r.total)]));
}
