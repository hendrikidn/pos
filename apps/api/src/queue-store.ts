import type { Queryable } from './db/driver';
import type { JumpFacts, SeatedFacts } from './queue';
import { labelOf } from './queue';

const num = (v: unknown) => Number(v);

/** Data antrian outlet untuk GuardService: tiket yang melewati antrian, dan tiket yang didudukkan (termasuk yang disebut event tautan). */
export async function queueFacts(q: Queryable, outletId: string, fromMs: number, linkedIds: number[]) {
  const jumps = (await q.query<{ id: string; seq: number; jump_reason: string; jump_note: string | null; jumped_over: string[]; called_at_ms: number; called_by: string | null }>(
    'select id, seq, jump_reason, jump_note, jumped_over, called_at_ms, called_by from queue_ticket where outlet_id = $1 and jump_reason is not null and called_at_ms >= $2', [outletId, fromMs],
  )).rows.map((r): JumpFacts => ({ id: num(r.id), label: labelOf(r.seq), reason: r.jump_reason, note: r.jump_note, skippedLabels: r.jumped_over ?? [], at: num(r.called_at_ms), actor: r.called_by }));
  const seatedRows = (await q.query<{ id: string; seq: number; seated_at_ms: number; seated_by: string | null }>(
    "select id, seq, seated_at_ms, seated_by from queue_ticket where outlet_id = $1 and status = 'SEATED' and (seated_at_ms >= $2 or id = any($3::bigint[]))", [outletId, fromMs, linkedIds],
  )).rows;
  const seated = seatedRows.map((r): SeatedFacts => ({ id: num(r.id), label: labelOf(r.seq), seatedAtMs: num(r.seated_at_ms), seatedBy: r.seated_by }));
  return { jumps, seated, knownIds: new Set(seated.map((s) => s.id)) };
}
