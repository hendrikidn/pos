import type { Queryable } from './db/driver';

const num = (v: unknown) => Number(v);

/** Jumlah uang muka yang sudah dipakai sebagai pembayaran, per reservasi (dari event, bukan kolom yang bisa diubah). */
export async function appliedDeposits(q: Queryable, outletId: string, ids?: number[]): Promise<Map<number, number>> {
  const rows = (await q.query<{ rid: string; total: string }>(
    // Pembayaran pada order yang kemudian di-void tidak dihitung terpakai: uang muka itu kembali menjadi sisa (bisa dipakai lagi atau dikembalikan).
    `select e.payload->>'reservationId' as rid, sum((e.payload->>'amount')::numeric) as total from event e
     where e.outlet_id = $1 and e.type = 'payment.received' and e.payload->>'method' = 'DEPOSIT'
       and ($2::text[] is null or e.payload->>'reservationId' = any($2::text[]))
       and not exists (select 1 from event v where v.outlet_id = e.outlet_id and v.type = 'void.approved' and v.payload->>'orderId' = e.payload->>'orderId')
     group by 1`,
    [outletId, ids ? ids.map(String) : null],
  )).rows;
  return new Map(rows.map((r) => [num(r.rid), num(r.total)]));
}
