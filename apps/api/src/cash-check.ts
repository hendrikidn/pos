import type { EventOf } from '@pos/events';
import { verifyCashCount } from '@pos/order';
import type { Queryable } from './db/driver';
import { EVENT_COLUMNS, rowToEvent, type EventRow } from './guard.service';

export interface CashCheckRow {
  deviceId: string;
  seq: number;
  shiftId: string;
  claimed: number;
  serverExpected: number;
  status: 'OK' | 'MISMATCH';
  openingCash: number;
  cashIn: number;
  cashOut: number;
}

/**
 * Menghitung ulang kas yang seharusnya untuk setiap `cash.counted` (sejak `fromMs`) yang belum diperiksa, dan menyimpan hasilnya.
 * Yang tidak dapat diverifikasi (tanpa pembukaan shift, atau rantai event belum utuh karena ada kiriman yang tertunda) tidak
 * disimpan sehingga dicoba lagi pada evaluasi berikutnya. Aman dipanggil berulang.
 */
/** Hitungan yang tidak dapat diverifikasi hanya dicoba ulang selama ini sejak terjadi; setelahnya dibiarkan memakai angka terminal. */
export const CASH_VERIFY_RETRY_MS = 4 * 86_400_000;

/** Awal jendela verifikasi: tidak lebih lama dari masa coba-ulang, agar hitungan yang selamanya tak terverifikasi tidak diperiksa terus. */
export const verifyWindowStart = (fromMs: number, now: number): number => Math.max(fromMs, now - CASH_VERIFY_RETRY_MS);

export async function verifyPendingCashCounts(q: Queryable, tenantId: string, outletId: string, fromMs: number, now: number): Promise<void> {
  fromMs = verifyWindowStart(fromMs, now);
  const counts = (
    await q.query<EventRow>(`select ${EVENT_COLUMNS} from event where outlet_id = $1 and type = 'cash.counted' and device_time_ms >= $2 order by device_id, seq`, [outletId, fromMs])
  ).rows.map(rowToEvent) as EventOf<'cash.counted'>[];
  if (counts.length === 0) return;
  const done = new Set(
    (await q.query<{ device_id: string; seq: number }>('select device_id, seq from cash_check where outlet_id = $1', [outletId])).rows.map((r) => `${r.device_id}#${r.seq}`),
  );
  for (const count of counts) {
    if (done.has(`${count.deviceId}#${count.seq}`)) continue;
    const open = (
      await q.query<{ seq: number }>(
        "select seq from event where device_id = $1 and type = 'shift.opened' and payload->>'shiftId' = $2 and seq < $3 order by seq desc limit 1",
        [count.deviceId, count.payload.shiftId, count.seq],
      )
    ).rows[0];
    if (!open) continue;
    const events = (
      await q.query<EventRow>(`select ${EVENT_COLUMNS} from event where device_id = $1 and seq >= $2 and seq <= $3 order by seq`, [count.deviceId, open.seq, count.seq])
    ).rows.map(rowToEvent);
    const c = verifyCashCount(count, events);
    if (c.status === 'UNVERIFIABLE') continue;
    await q.query(
      `insert into cash_check (tenant_id, outlet_id, device_id, seq, shift_id, claimed, server_expected, status, opening_cash, cash_in, cash_out)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict do nothing`,
      [tenantId, outletId, c.deviceId, c.seq, c.shiftId, c.claimed, c.serverExpected, c.status, c.openingCash, c.cashIn, c.cashOut],
    );
  }
}

export async function loadCashChecks(q: Queryable, outletId: string): Promise<CashCheckRow[]> {
  return (
    await q.query<{ device_id: string; seq: number; shift_id: string; claimed: number; server_expected: number; status: 'OK' | 'MISMATCH'; opening_cash: number; cash_in: number; cash_out: number }>(
      'select device_id, seq, shift_id, claimed, server_expected, status, opening_cash, cash_in, cash_out from cash_check where outlet_id = $1',
      [outletId],
    )
  ).rows.map((r) => ({
    deviceId: r.device_id, seq: Number(r.seq), shiftId: r.shift_id, claimed: Number(r.claimed), serverExpected: Number(r.server_expected),
    status: r.status, openingCash: Number(r.opening_cash), cashIn: Number(r.cash_in), cashOut: Number(r.cash_out),
  }));
}
