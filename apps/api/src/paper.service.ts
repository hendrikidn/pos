import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiAuth } from './auth';
import { Database } from './db/database';
import { paperUsage, PAPER_DOC_CM, PAPER_ROLL_METERS } from './integrity';
import { CLOCK, type Clock } from './pipeline.service';

const need = (ok: unknown, message: string): void => {
  if (!ok) throw new BadRequestException(message);
};
const num = (v: unknown) => Number(v);

export interface PaperInput { kind?: unknown; rolls?: unknown; note?: unknown }

/** Catatan gulungan kertas printer (beli dan hitung sisa) untuk aturan R16: pemakaian gulungan dibandingkan dengan jumlah cetakan di POS. */
@Injectable()
export class PaperService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async add(auth: ApiAuth, outletId: string, input: PaperInput, now = this.clock()): Promise<{ id: number }> {
    need(input.kind === 'PURCHASE' || input.kind === 'COUNT', 'kind harus PURCHASE atau COUNT');
    need(Number.isInteger(input.rolls) && (input.rolls as number) >= 0 && (input.rolls as number) <= 10_000, 'jumlah gulungan harus bilangan bulat 0–10.000');
    need(input.kind === 'COUNT' || (input.rolls as number) > 0, 'jumlah pembelian harus lebih dari 0');
    const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null;
    need(note === null || note.length <= 140, 'catatan maksimal 140 karakter');
    return this.db.tenantTx(auth.tenantId, async (q) => {
      if ((await q.query('select 1 from outlet where id = $1', [outletId])).rowCount === 0) throw new NotFoundException('outlet tidak ditemukan');
      const id = num((await q.query<{ id: string }>('insert into paper_roll_log (tenant_id, outlet_id, kind, rolls, note, user_id, at_ms) values ($1, $2, $3, $4, $5, $6, $7) returning id', [auth.tenantId, outletId, input.kind, input.rolls, note, auth.userId, now])).rows[0]!.id);
      await q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [auth.tenantId, auth.userId, 'paper.log', JSON.stringify({ outletId, kind: input.kind, rolls: input.rolls })]);
      return { id };
    });
  }

  /** Riwayat dan, untuk tiap hitung sisa, pemakaian sejak hitung sebelumnya dibanding perkiraan dari cetakan. */
  async list(auth: ApiAuth, outletId: string) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      if ((await q.query('select 1 from outlet where id = $1', [outletId])).rowCount === 0) throw new NotFoundException('outlet tidak ditemukan');
      const rows = (await q.query<{ id: string; kind: 'PURCHASE' | 'COUNT'; rolls: number; note: string | null; user_id: string; at_ms: number }>('select id, kind, rolls, note, user_id, at_ms from paper_roll_log where outlet_id = $1 order by at_ms, id', [outletId])).rows;
      const counts = rows.filter((r) => r.kind === 'COUNT');
      const periods = [] as { countId: number; at: number; consumed: number; documents: number; expected: number; flagged: boolean }[];
      for (let i = 1; i < counts.length; i++) {
        const a = counts[i - 1]!;
        const b = counts[i]!;
        const purchased = rows.filter((r) => r.kind === 'PURCHASE' && num(r.at_ms) > num(a.at_ms) && num(r.at_ms) <= num(b.at_ms)).reduce((s, r) => s + r.rolls, 0);
        const documents = num((await q.query<{ n: string }>("select count(*) as n from event where outlet_id = $1 and type in ('bill.printed', 'receipt.printed') and device_time_ms > $2 and device_time_ms <= $3", [outletId, a.at_ms, b.at_ms])).rows[0]!.n);
        const u = paperUsage(a.rolls, b.rolls, purchased, documents);
        periods.push({ countId: num(b.id), at: num(b.at_ms), consumed: u.consumed, documents, expected: Math.round(u.expected * 10) / 10, flagged: u.flagged });
      }
      return {
        assumptions: { rollMeters: PAPER_ROLL_METERS, docCm: PAPER_DOC_CM },
        entries: rows.slice().reverse().slice(0, 60).map((r) => ({ id: num(r.id), kind: r.kind, rolls: r.rolls, note: r.note, userId: r.user_id, at: num(r.at_ms) })),
        periods: periods.reverse(),
      };
    });
  }
}
