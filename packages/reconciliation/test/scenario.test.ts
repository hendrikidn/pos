import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BankTxn, PosPayment } from '@pos/domain';
import { parseBankReport } from '@pos/bank-parsers';
import { reconcile, type ReconcileInput } from '../src';

const root = resolve(__dirname, '../../../fixtures');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

interface Scenario {
  pos_payments: {
    order_id: string; paid_at: string; tid: string;
    method: PosPayment['method']; amount: number; approval_code: string | null;
  }[];
  expected: {
    matched: number;
    r7_not_in_bank: string[];
    pending_settlement_not_flagged: string[];
    r8_amount_lower_in_bank: { order_id: string; pos: number; bank: number }[];
    orphan_bank_txn: { bank: string; approval_code: string; amount: number }[];
    ambiguous_resolved_fifo: [string, string][];
    r10_daily_gross: Record<string, { pos: number; bank: number }>;
  };
}

const scenario: Scenario = JSON.parse(read('scenarios/2026-10-01-senopati.json'));

function load(): ReconcileInput {
  const reports = [
    'mock-bca-merchant-2026-10-01.csv',
    'mock-bri-merchant-2026-10-01.csv',
    'mock-mandiri-merchant-2026-10-01.csv',
  ].map((f) => parseBankReport(read(`bank-reports/${f}`)));

  const bankTxns: BankTxn[] = reports.flatMap((r) => r.txns);
  const coverage: Record<string, number> = {};
  for (const r of reports) {
    if (r.coverageEndMs === null) continue;
    for (const tid of new Set(r.txns.map((t) => t.tid))) coverage[tid] = r.coverageEndMs;
  }
  const posPayments: PosPayment[] = scenario.pos_payments.map((p) => ({
    orderId: p.order_id,
    paidAt: Date.parse(p.paid_at),
    tid: p.tid,
    method: p.method,
    amount: p.amount,
    approvalCode: p.approval_code,
  }));
  return { posPayments, bankTxns, coverage };
}

describe('skenario 2026-10-01 (BCA + BRI + Mandiri)', () => {
  const input = load();
  const result = reconcile(input);
  const ids = (rule: string) =>
    result.findings.filter((f) => f.rule === rule).map((f) => ('orderId' in f ? f.orderId : '')).sort();

  it('20 pembayaran cocok bersih (di luar pasangan R8)', () => {
    const r8 = result.findings.filter((f) => f.rule === 'R8').length;
    expect(result.matches).toHaveLength(scenario.expected.matched + r8);
  });

  it('R7: tidak ada di bank', () => {
    expect(ids('R7')).toEqual([...scenario.expected.r7_not_in_bank].sort());
  });

  it('pembayaran setelah batas pencairan = pending, bukan R7', () => {
    expect(ids('PENDING_SETTLEMENT')).toEqual(scenario.expected.pending_settlement_not_flagged);
    expect(ids('R7')).not.toContain('ord-0024');
  });

  it('R8: nominal bank lebih kecil', () => {
    const r8 = result.findings.filter((f) => f.rule === 'R8');
    expect(r8).toHaveLength(1);
    expect(r8[0]).toMatchObject({ orderId: 'ord-0009', posAmount: 68000, bankAmount: 34000 });
  });

  it('R26: transaksi bank tanpa pembayaran POS', () => {
    const orphans = result.findings.filter((f) => f.rule === 'R26');
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ approvalCode: '123410', amount: 87500 });
  });

  it('dua pembayaran Rp 56.500 berdekatan tidak tertukar', () => {
    for (const [orderId, approval] of scenario.expected.ambiguous_resolved_fifo) {
      const m = result.matches.find((x) => x.orderId === orderId)!;
      expect(input.bankTxns[m.bankIndex]!.approvalCode).toBe(approval);
    }
  });

  it('tidak ada temuan lain (tanpa false positive)', () => {
    const expectedCount = 3 /* R7 */ + 1 /* pending */ + 1 /* R8 */ + 1 /* R26 */;
    expect(result.findings).toHaveLength(expectedCount);
  });

  it('R10: total bruto per TID cocok dengan skenario, dan selisihnya sudah dijelaskan R7/R8/R26', () => {
    const byTid = Object.fromEntries(result.r10.map((d) => [d.tid, d]));
    const exp = scenario.expected.r10_daily_gross;
    const pick = (prefix: string) => Object.entries(exp).find(([k]) => k.startsWith(prefix))![1];
    for (const [tid, bank] of [['12345678', 'BCA'], ['87654321', 'BRI'], ['55556666', 'MANDIRI']] as const) {
      expect(byTid[tid]).toMatchObject({ posGross: pick(bank).pos, bankGross: pick(bank).bank, residual: 0, flagged: false });
    }
  });
});

describe('perilaku engine', () => {
  const base = (over: Partial<PosPayment> = {}): PosPayment => ({
    orderId: 'o1', paidAt: Date.parse('2026-10-01T10:00:00+07:00'), tid: 'T1',
    method: 'QRIS', amount: 50000, approvalCode: null, ...over,
  });
  const bankTxn = (over: Partial<BankTxn> = {}): BankTxn => ({
    bank: 'BCA', mid: 'M', tid: 'T1', txnDate: '2026-10-01', txnAt: Date.parse('2026-10-01T10:00:30+07:00'),
    channel: 'QRIS', amount: 50000, mdr: null, netAmount: null, approvalCode: 'A1', rrn: null,
    status: 'SUCCESS', settlementBatchId: null, settledAt: null, sourceRow: 1, ...over,
  });
  const cover = { T1: Date.parse('2026-10-01T23:59:59+07:00') };

  it('tanpa laporan untuk TID → NO_BANK_REPORT, bukan R7', () => {
    const r = reconcile({ posPayments: [base()], bankTxns: [], coverage: {} });
    expect(r.findings.map((f) => f.rule)).toEqual(['NO_BANK_REPORT']);
  });

  it('di luar jendela waktu → R7 dan R26', () => {
    const r = reconcile({
      posPayments: [base()],
      bankTxns: [bankTxn({ txnAt: Date.parse('2026-10-01T10:30:00+07:00') })],
      coverage: cover,
    });
    expect(r.findings.map((f) => f.rule).sort()).toEqual(['R26', 'R7']);
  });

  it('kode approval mengalahkan waktu', () => {
    const r = reconcile({
      posPayments: [base({ approvalCode: 'A1' })],
      bankTxns: [bankTxn({ txnAt: Date.parse('2026-10-01T10:45:00+07:00') })],
      coverage: cover,
    });
    expect(r.matches).toMatchObject([{ level: 'APPROVAL' }]);
    expect(r.findings).toEqual([]);
  });

  it('bank tanpa jam dicocokkan per tanggal', () => {
    const r = reconcile({
      posPayments: [base()],
      bankTxns: [bankTxn({ txnAt: null })],
      coverage: cover,
    });
    expect(r.matches).toMatchObject([{ level: 'DAY' }]);
  });

  it('kanal berbeda tidak dicocokkan (QRIS vs debit)', () => {
    const r = reconcile({
      posPayments: [base()],
      bankTxns: [bankTxn({ channel: 'CARD_DEBIT' })],
      coverage: cover,
    });
    expect(r.matches).toHaveLength(0);
  });

  it('transaksi bank non-sukses diabaikan', () => {
    const r = reconcile({
      posPayments: [base()],
      bankTxns: [bankTxn({ status: 'FAILED' })],
      coverage: cover,
    });
    expect(r.findings.map((f) => f.rule)).toEqual(['R7']);
  });

  it('satu transaksi bank tidak bisa dipakai dua kali', () => {
    const r = reconcile({
      posPayments: [base({ orderId: 'a' }), base({ orderId: 'b', paidAt: base().paidAt + 20_000 })],
      bankTxns: [bankTxn()],
      coverage: cover,
    });
    expect(r.matches).toHaveLength(1);
    expect(r.findings.map((f) => f.rule)).toEqual(['R7']);
  });

  it('R10: bank menerima lebih dari yang dicatat POS (cocok lewat approval) menjadi selisih tak terjelaskan', () => {
    const r = reconcile({
      posPayments: [base({ approvalCode: 'A1', amount: 40_000 })],
      bankTxns: [bankTxn({ amount: 50_000 })],
      coverage: cover,
    });
    expect(r.findings).toEqual([]);
    expect(r.r10).toEqual([
      expect.objectContaining({ posGross: 40_000, bankGross: 50_000, explained: 0, residual: -10_000, flagged: true }),
    ]);
  });

  it('R10: R7 menjelaskan selisihnya sendiri, tidak dihitung dua kali', () => {
    const r = reconcile({ posPayments: [base()], bankTxns: [], coverage: cover });
    expect(r.findings.map((f) => f.rule)).toEqual(['R7']);
    expect(r.r10[0]).toMatchObject({ posGross: 50_000, bankGross: 0, explained: 50_000, residual: 0, flagged: false });
  });
});
