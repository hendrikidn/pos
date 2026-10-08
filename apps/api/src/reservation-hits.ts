import { correctedTime, type EventOf, type PosEvent } from '@pos/events';
import type { Queryable } from './db/driver';
import { EVENT_COLUMNS, rowToEvent, type EventRow } from './guard.service';
import { appliedDeposits } from './reservation-store';
import { checkDepositPayment, unsettledDeadline, type ReservationFacts, type ReservationStatus, type SettleKind } from './reservation';

const num = (v: unknown) => Number(v);

interface FactRow {
  id: string; status: ReservationStatus; start_ms: number; duration_min: number; deposit: string; deposit_at_ms: number | null; deposit_by: string | null;
  status_at_ms: number | null; settle_kind: SettleKind | null; settle_at_ms: number | null;
}
const FACT_COLS = 'id, status, start_ms, duration_min, deposit, deposit_at_ms, deposit_by, status_at_ms, settle_kind, settle_at_ms';
const facts = (r: FactRow): ReservationFacts => ({
  id: num(r.id), status: r.status, startMs: num(r.start_ms), durationMin: r.duration_min, deposit: num(r.deposit), depositAtMs: r.deposit_at_ms === null ? null : num(r.deposit_at_ms),
  depositBy: r.deposit_by, statusAtMs: r.status_at_ms === null ? null : num(r.status_at_ms), settleKind: r.settle_kind, settleAtMs: r.settle_at_ms === null ? null : num(r.settle_at_ms),
});

export interface ReservationHit { rule: 'R43' | 'R44'; key: string; at: number; actor: string | null; terminalId: string | null; orderId: string | null; note: string }

/**
 * Temuan uang muka untuk GuardService:
 *  - R43: pembayaran dengan uang muka yang tidak sah (reservasi tidak ada atau tanpa uang muka, dipakai sebelum dicatat, sesudah dikembalikan/
 *    dihanguskan/dibatalkan, melebihi jumlahnya, atau jauh di luar jam reservasi). Memeriksa semua pembayaran uang muka reservasi itu,
 *    bukan hanya yang di jendela, supaya pemakaian berulang tetap terhitung.
 *  - R44: uang muka yang masih ditahan lebih dari 24 jam setelah reservasi berakhir atau dibatalkan tanpa dikembalikan/dihanguskan.
 */
export async function reservationHits(q: Queryable, outletId: string, windowEvents: PosEvent[], now: number): Promise<ReservationHit[]> {
  const hits: ReservationHit[] = [];
  const inWindow = windowEvents.filter((e): e is EventOf<'payment.received'> => e.type === 'payment.received' && e.payload.method === 'DEPOSIT' && Number.isInteger(e.payload.reservationId));
  if (inWindow.length > 0) {
    const ids = [...new Set(inWindow.map((e) => e.payload.reservationId!))];
    const rows = (await q.query<FactRow>(`select ${FACT_COLS} from reservation where outlet_id = $1 and id = any($2::bigint[])`, [outletId, ids])).rows;
    const byId = new Map(rows.map((r) => [num(r.id), facts(r)]));
    // Semua pembayaran uang muka reservasi itu sepanjang waktu, berurutan, agar jumlah terpakai sebelumnya benar.
    const all = (await q.query<EventRow>(
      `select ${EVENT_COLUMNS} from event where outlet_id = $1 and type = 'payment.received' and payload->>'method' = 'DEPOSIT' and payload->>'reservationId' = any($2::text[]) order by device_id, seq`,
      [outletId, ids.map(String)],
    )).rows.map(rowToEvent).filter((e): e is EventOf<'payment.received'> => e.type === 'payment.received');
    const ordered = [...all].sort((a, b) => correctedTime(a) - correctedTime(b) || a.deviceId.localeCompare(b.deviceId) || a.seq - b.seq);
    // Order yang di-void tidak menghabiskan uang muka: pembayarannya tidak ikut menjumlah pemakaian sebelumnya.
    const voidedOrders = new Set((await q.query<{ oid: string }>(
      "select payload->>'orderId' as oid from event where outlet_id = $1 and type = 'void.approved' and payload->>'orderId' = any($2::text[])", [outletId, ordered.map((e) => e.payload.orderId)],
    )).rows.map((r) => r.oid));
    const before = new Map<string, number>(); // `${deviceId}:${seq}` → jumlah terpakai sebelum pembayaran ini
    const running = new Map<number, number>();
    for (const e of ordered) {
      const rid = e.payload.reservationId!;
      before.set(`${e.deviceId}:${e.seq}`, running.get(rid) ?? 0);
      if (!voidedOrders.has(e.payload.orderId)) running.set(rid, (running.get(rid) ?? 0) + e.payload.amount);
    }
    for (const e of inWindow) {
      const rid = e.payload.reservationId!;
      const at = correctedTime(e);
      const why = checkDepositPayment(byId.get(rid), before.get(`${e.deviceId}:${e.seq}`) ?? 0, e.payload.amount, at, rid);
      if (why) hits.push({ rule: 'R43', key: `R43:${e.deviceId}:${e.seq}`, at, actor: e.actorId ?? null, terminalId: e.deviceId, orderId: e.payload.orderId, note: `pembayaran uang muka Rp ${e.payload.amount.toLocaleString('id-ID')}: ${why}` });
    }
  }

  const open = (await q.query<FactRow>(`select ${FACT_COLS} from reservation where outlet_id = $1 and deposit > 0 and settle_kind is null and start_ms >= $2`, [outletId, now - 60 * 86_400_000])).rows;
  if (open.length > 0) {
    const applied = await appliedDeposits(q, outletId, open.map((r) => num(r.id)));
    for (const r of open) {
      const f = facts(r);
      const deadline = unsettledDeadline(f, applied.get(f.id) ?? 0);
      if (deadline === null || now < deadline) continue;
      hits.push({
        rule: 'R44', key: `R44:${f.id}`, at: deadline, actor: f.depositBy, terminalId: null, orderId: null,
        note: `uang muka reservasi #${f.id} (Rp ${(f.deposit - (applied.get(f.id) ?? 0)).toLocaleString('id-ID')} tersisa) belum dikembalikan, dihanguskan, atau dipakai lebih dari 24 jam setelah reservasi berakhir`,
      });
    }
  }
  return hits;
}
