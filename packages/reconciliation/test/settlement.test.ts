import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PosPayment, PosPaymentMethod } from '@pos/domain';
import { parseMandiriSettlement } from '@pos/bank-parsers';
import { reconcileSettlement, subsetCandidates } from '../src';

const slip = readFileSync(resolve(__dirname, '../../../fixtures/bank-reports/mandiri-settlement-slip-2026-10-01.txt'), 'utf8');
const summary = parseMandiriSettlement(slip).summaries[0]!;
const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const START = WIB('2026-10-01T00:00:00'); // batch sebelumnya ditutup tengah malam

let n = 0;
const pay = (method: PosPaymentMethod, amount: number, at = '12:00:00'): PosPayment => ({
  orderId: `ord-${++n}`, paidAt: WIB(`2026-10-01T${at}`), tid: summary.tid, method, amount, approvalCode: null,
});

/** 29 pembayaran QRIS senilai total Rp 770.000 (28 × 26.000 + 1 × 42.000) dan 1 kartu kredit Rp 15.000: persis seperti slip. */
function matching(): PosPayment[] {
  n = 0;
  const qris = Array.from({ length: 28 }, () => pay('QRIS', 26_000)).concat(pay('QRIS', 42_000));
  return [...qris, pay('EDC_CREDIT', 15_000)];
}

const run = (posPayments: PosPayment[], windowStartMs: number | null = START) =>
  reconcileSettlement({ summary, posPayments, windowStartMs });

describe('rekonsiliasi batch settlement', () => {
  it('POS persis sama dengan slip: tidak ada temuan', () => {
    const r = run(matching());
    expect(r.findings).toEqual([]);
    expect(r.channels.every((c) => c.ok)).toBe(true);
  });

  it('QRIS pribadi: POS mencatat satu pembayaran QRIS yang tidak masuk EDC → R27 dengan kandidat order', () => {
    const payments = matching();
    const extra = pay('QRIS', 64_000);
    const r = run([...payments, extra]);
    expect(r.findings).toEqual([
      expect.objectContaining({
        rule: 'R27', channel: 'QRIS', diffCount: 1, diffAmount: 64_000,
        pos: { count: 30, amount: 834_000 }, slip: { count: 29, amount: 770_000 },
      }),
    ]);
    const f = r.findings[0] as { candidates: string[][] };
    expect(f.candidates).toContainEqual([extra.orderId]);
  });

  it('beberapa pembayaran hilang: kandidat berupa kombinasi yang jumlahnya pas', () => {
    const payments = matching();
    const a = pay('QRIS', 30_000);
    const b = pay('QRIS', 45_000);
    const r = run([...payments, a, b]);
    const f = r.findings[0] as { diffCount: number; diffAmount: number; candidates: string[][] };
    expect([f.diffCount, f.diffAmount]).toEqual([2, 75_000]);
    expect(f.candidates).toContainEqual([a.orderId, b.orderId]);
  });

  it('salah memilih metode (kartu kredit dicatat sebagai QRIS) → R28, bukan R27', () => {
    n = 0;
    const qris = Array.from({ length: 28 }, () => pay('QRIS', 26_000)).concat(pay('QRIS', 42_000));
    const mistaken = pay('QRIS', 15_000); // sebenarnya kartu kredit
    const r = run([...qris, mistaken]);
    expect(r.findings).toEqual([
      expect.objectContaining({ rule: 'R28', recordedAs: 'QRIS', settledAs: 'CARD_CREDIT', count: 1, amount: 15_000, candidates: [[mistaken.orderId]] }),
    ]);
  });

  it('nominal diturunkan tanpa mengubah jumlah transaksi → R27 tanpa kandidat', () => {
    const payments = matching();
    payments[0] = { ...payments[0]!, amount: 6_000 }; // slip melihat 26.000
    const r = run(payments);
    const f = r.findings[0] as { rule: string; diffCount: number; diffAmount: number; candidates: string[][] };
    expect(f).toMatchObject({ rule: 'R27', diffCount: 0, diffAmount: -20_000, candidates: [] });
  });

  it('slip lebih besar dari POS (EDC menerima transaksi yang tidak ada di POS) → R27 negatif', () => {
    const payments = matching().slice(0, 28).concat(matching().slice(-1)); // buang satu QRIS
    const r = run(payments);
    const f = r.findings.find((x) => x.rule === 'R27') as { channel: string; diffCount: number } | undefined;
    expect(f).toMatchObject({ channel: 'QRIS', diffCount: -1 });
  });

  it('pembayaran di luar jendela batch atau di TID lain tidak dihitung', () => {
    const payments = matching();
    payments.push({ ...pay('QRIS', 99_000), paidAt: WIB('2026-10-01T22:30:00') }); // setelah batch ditutup
    payments.push({ ...pay('QRIS', 77_000), tid: 'TID-LAIN' });
    payments.push({ ...pay('QRIS', 55_000), paidAt: WIB('2026-09-30T20:00:00') }); // batch sebelumnya
    expect(run(payments).findings).toEqual([]);
  });

  it('tanpa batas awal batch, dianggap awal hari dan diberi catatan', () => {
    const r = run(matching(), null);
    expect(r.findings).toEqual([{ rule: 'WINDOW_ASSUMED', fromMs: START }]);
  });

  it('jenis pembayaran yang ada di POS tetapi tidak ada di slip dilaporkan', () => {
    const payments = [...matching(), pay('EDC_DEBIT', 20_000)];
    const f = run(payments).findings.find((x) => x.rule === 'R27') as { channel: string } | undefined;
    expect(f).toMatchObject({ channel: 'CARD_DEBIT' });
  });
});

describe('subsetCandidates', () => {
  const p = (orderId: string, amount: number) => ({ orderId, amount }) as PosPayment;
  it('menemukan kombinasi pas dan membatasi jumlah kandidat', () => {
    const list = [p('a', 10), p('b', 20), p('c', 30), p('d', 10), p('e', 20)];
    expect(subsetCandidates(list, 2, 30)).toEqual([['a', 'b'], ['a', 'e'], ['b', 'd'], ['d', 'e']]);
    expect(subsetCandidates(list, 4, 30)).toEqual([]);
    expect(subsetCandidates(list, 1, 999)).toEqual([]);
  });
});
