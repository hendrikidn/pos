import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { parseBankReport, ParseError } from '@pos/bank-parsers';
import { bankTxnKey, type BankTxn, type PosPayment, type PosPaymentMethod } from '@pos/domain';
import { correctedTime } from '@pos/events';
import { reconcile, type Finding } from '@pos/reconciliation';
import type { RuleHit } from '@pos/rules';
import { Database } from './db/database';
import type { Queryable } from './db/driver';
import { EVENT_COLUMNS, LOOKBACK_MS, rowToEvent, type EventRow } from './guard.service';

const WEIGHTS = { R7: 35, R8: 35, R26: 30, R10: 30 } as const;

export interface ImportResult {
  reportId: number;
  bank: string;
  txnCount: number;
  newTxns: number;
  parseErrors: { row: number; message: string }[];
  findings: number;
}

export interface PaymentInfo {
  orderId: string;
  terminalId: string;
  actorId: string | null;
  paidAt: number;
  amount: number;
}

/** Pembayaran non-tunai dari event POS sejak `from`, dalam bentuk untuk rekonsiliasi dan keterangan pelaku. */
export async function loadNonCashPayments(
  q: Queryable, outletId: string, from: number,
): Promise<{ posPayments: PosPayment[]; info: Map<string, PaymentInfo> }> {
  const events = (
    await q.query<EventRow>(
      `select ${EVENT_COLUMNS} from event
       where outlet_id = $1 and type = 'payment.received' and device_time_ms >= $2 order by device_id, seq`,
      [outletId, from],
    )
  ).rows.map(rowToEvent);
  const info = new Map<string, PaymentInfo>();
  const posPayments: PosPayment[] = [];
  for (const e of events) {
    if (e.type !== 'payment.received' || e.payload.method === 'CASH' || !e.payload.tid) continue;
    const paidAt = correctedTime(e);
    posPayments.push({
      orderId: e.payload.orderId, paidAt, tid: e.payload.tid, method: e.payload.method as PosPaymentMethod,
      amount: e.payload.amount, approvalCode: e.payload.approvalCode ?? null,
    });
    info.set(e.payload.orderId, { orderId: e.payload.orderId, terminalId: e.deviceId, actorId: e.actorId, paidAt, amount: e.payload.amount });
  }
  return { posPayments, info };
}

@Injectable()
export class BankService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** Mengimpor laporan bank lalu menjalankan ulang rekonsiliasi untuk seluruh jendela 72 jam. */
  async importReport(
    tenantId: string, outletId: string, userId: string, text: string, filename?: string, now = Date.now(),
  ): Promise<ImportResult> {
    if (typeof text !== 'string' || text.trim() === '') throw new BadRequestException('isi laporan kosong');

    return this.db.tenantTx(tenantId, async (q) => {
      const outlet = (
        await q.query<{ utc_offset_minutes: number }>('select utc_offset_minutes from outlet where id = $1', [outletId])
      ).rows[0];
      if (!outlet) throw new BadRequestException('outlet tidak ditemukan');

      let report;
      try {
        report = parseBankReport(text, { utcOffsetMinutes: outlet.utc_offset_minutes });
      } catch (e) {
        if (e instanceof ParseError) throw new BadRequestException(e.message);
        throw e;
      }

      const rep = (
        await q.query<{ id: number }>(
          `insert into bank_report (tenant_id, outlet_id, bank, filename, uploaded_by, txn_count, coverage_end_ms, errors)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) returning id`,
          [tenantId, outletId, report.bank, filename ?? null, userId, report.txns.length, report.coverageEndMs, JSON.stringify(report.errors)],
        )
      ).rows[0]!;

      let newTxns = 0;
      for (const t of report.txns) {
        const r = await q.query(
          `insert into bank_txn (tenant_id, outlet_id, key, report_id, txn_ms, data)
           values ($1, $2, $3, $4, $5, $6::jsonb) on conflict (outlet_id, key) do nothing`,
          [tenantId, outletId, bankTxnKey(t), rep.id, t.txnAt, JSON.stringify(t)],
        );
        newTxns += r.rowCount;
      }
      if (report.coverageEndMs !== null) {
        for (const tid of new Set(report.txns.map((t) => t.tid))) {
          await q.query(
            `insert into bank_coverage (tenant_id, outlet_id, tid, coverage_end_ms) values ($1, $2, $3, $4)
             on conflict (outlet_id, tid) do update set coverage_end_ms = greatest(bank_coverage.coverage_end_ms, excluded.coverage_end_ms)`,
            [tenantId, outletId, tid, report.coverageEndMs],
          );
        }
      }

      const findings = await this.reconcileOutlet(q, tenantId, outletId, outlet.utc_offset_minutes, now);
      return {
        reportId: rep.id, bank: report.bank, txnCount: report.txns.length, newTxns,
        parseErrors: report.errors, findings,
      };
    });
  }

  /** Mencocokkan pembayaran non-tunai POS (72 jam) dengan semua transaksi bank tersimpan, lalu menyimpan temuannya sebagai hit aturan. */
  private async reconcileOutlet(
    q: Queryable, tenantId: string, outletId: string, utcOffsetMinutes: number, now: number,
  ): Promise<number> {
    const from = now - LOOKBACK_MS;
    const { posPayments, info } = await loadNonCashPayments(q, outletId, from);

    const bankTxns = (
      await q.query<{ data: BankTxn }>('select data from bank_txn where outlet_id = $1 and (txn_ms is null or txn_ms >= $2)', [outletId, from - 86_400_000])
    ).rows.map((r) => r.data);
    const coverage = Object.fromEntries(
      (await q.query<{ tid: string; coverage_end_ms: number }>('select tid, coverage_end_ms from bank_coverage where outlet_id = $1', [outletId]))
        .rows.map((r) => [r.tid, r.coverage_end_ms]),
    );

    const result = reconcile({ posPayments, bankTxns, coverage, options: { utcOffsetMinutes } });
    const hits = this.toHits(outletId, result.findings, result.r10, info, bankTxns);

    await q.query("delete from bank_finding where outlet_id = $1 and at_ms >= $2 and source = 'TXN'", [outletId, from]);
    for (const h of hits) {
      await q.query(
        'insert into bank_finding (tenant_id, outlet_id, hit_key, at_ms, hit) values ($1, $2, $3, $4, $5::jsonb) on conflict (outlet_id, hit_key) do nothing',
        [tenantId, outletId, h.key, h.at, JSON.stringify(h)],
      );
    }
    return hits.length;
  }

  private toHits(
    outletId: string,
    findings: Finding[],
    r10: { tid: string; date: string; posGross: number; bankGross: number; flagged: boolean }[],
    info: Map<string, PaymentInfo>,
    bank: BankTxn[],
  ): RuleHit[] {
    const base = { outletId, context: false, confidence: 'HIGH' as const, modalities: ['BANK' as const, 'POS' as const] };
    const hits: RuleHit[] = [];
    for (const f of findings) {
      if (f.rule === 'R7' || f.rule === 'R8') {
        const p = info.get(f.orderId);
        const at = p?.paidAt ?? 0;
        hits.push({
          ...base, rule: f.rule, key: `${f.rule}:${f.orderId}`, weight: WEIGHTS[f.rule], terminalId: p?.terminalId ?? null,
          orderId: f.orderId, actorIds: p?.actorId ? [p.actorId] : [], at, windowStart: at, windowEnd: at,
          note: f.rule === 'R7'
            ? `pembayaran ${f.amount} tercatat non-tunai di POS tetapi tidak ada di laporan bank (TID ${f.tid})`
            : `nominal POS ${f.posAmount}, nominal bank ${f.bankAmount} (selisih ${f.posAmount - f.bankAmount})`,
        });
      } else if (f.rule === 'R26') {
        const t = bank[f.bankIndex]!;
        const at = t.txnAt ?? 0;
        hits.push({
          ...base, rule: 'R26', key: `R26:${bankTxnKey(t)}`, weight: WEIGHTS.R26, terminalId: null, orderId: null,
          actorIds: [], at, windowStart: at, windowEnd: at,
          note: `transaksi bank ${f.amount} (approval ${f.approvalCode ?? '-'}) tanpa pembayaran POS; mungkin dicatat tunai`,
        });
      }
    }
    for (const d of r10) {
      if (!d.flagged) continue;
      const at = Date.parse(`${d.date}T23:59:59+07:00`);
      hits.push({
        ...base, modalities: ['BANK'], rule: 'R10', key: `R10:${d.tid}:${d.date}`, weight: WEIGHTS.R10, terminalId: null,
        orderId: null, actorIds: [], at, windowStart: at, windowEnd: at,
        note: `total harian TID ${d.tid}: POS ${d.posGross}, bank ${d.bankGross}`,
      });
    }
    return hits;
  }
}
