import { describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import {
  buildSalesJournal, checkJournalLines, DEFAULT_ACCOUNTS, incomeStatement, journalCsvRows, ledger, sumCredit, sumDebit, trialBalance, SYSTEM,
  type JournalEntry,
} from '../src/accounting';
import { DAY_MS, startOfLocalDay } from '../src/sales-report';

const D1 = '2026-10-01';
const D2 = '2026-10-02';
const NOW = Date.parse('2026-10-03T09:00:00+07:00');
const at = (d: string, hms: string) => Date.parse(`${d}T${hms}+07:00`);

function journal(s: Sim, from = D1, to = D2, cashChecks: { deviceId: string; seq: number; claimed: number; serverExpected: number }[] = []) {
  return buildSalesJournal({ events: s.events, from, to, utcOffsetMinutes: 420, now: NOW, fromMs: startOfLocalDay(from, 420), toMs: startOfLocalDay(to, 420) + DAY_MS, outletId: 'o1', cashChecks });
}
const line = (e: JournalEntry, acc: string) => e.lines.find((l) => l.account === acc);

function sample(): Sim {
  const s = new Sim('o1', D1, 'term-1', 'sensor-1');
  // order A: Rp 100.000 + service 5.000 − diskon 10.000 + PBJT 9.500 + pembulatan 0 = 104.500; bayar tunai 54.500 + QRIS 50.000
  s.pos({ type: 'order.created', payload: { orderId: 'a', orderType: 'DINE_IN' } }, at(D1, '10:00:00'), 'budi');
  s.pos({ type: 'bill.printed', payload: { orderId: 'a', total: 104_500, items: [{ itemId: 'k', name: 'K', qty: 1, unitPrice: 100_000 }], breakdown: { subtotal: 100_000, discount: 10_000, service: 5_000, tax: 9_500, rounding: 0 } } }, at(D1, '10:01:00'), 'budi');
  s.pos({ type: 'payment.received', payload: { orderId: 'a', method: 'CASH', amount: 54_500 } }, at(D1, '10:02:00'), 'budi');
  s.pos({ type: 'payment.received', payload: { orderId: 'a', method: 'QRIS', amount: 50_000, tid: '12345678' } }, at(D1, '10:03:00'), 'budi');
  // order B: dibulatkan turun 300 → 22.000 − 300... subtotal 22.300 + tax 2.230 = 24.530 → total 24.500 (pembulatan −30)
  s.pos({ type: 'order.created', payload: { orderId: 'b', orderType: 'TAKE_AWAY' } }, at(D1, '11:00:00'), 'sari');
  s.pos({ type: 'bill.printed', payload: { orderId: 'b', total: 24_500, breakdown: { subtotal: 22_300, discount: 0, service: 0, tax: 2_230, rounding: -30 } } }, at(D1, '11:01:00'), 'sari');
  s.pos({ type: 'payment.received', payload: { orderId: 'b', method: 'CASH', amount: 24_500 } }, at(D1, '11:02:00'), 'sari');
  // order C (hari 2): terminal lama tanpa rincian
  s.pos({ type: 'order.created', payload: { orderId: 'c', orderType: 'TAKE_AWAY' } }, at(D2, '09:00:00'), 'sari');
  s.pos({ type: 'payment.received', payload: { orderId: 'c', method: 'EDC_DEBIT', amount: 33_000, tid: '12345678' } }, at(D2, '09:01:00'), 'sari');
  // refund tunai 5.000 untuk order C?? (metode kartu) → refund QRIS 3.000 untuk order A
  s.pos({ type: 'refund.created', payload: { refundId: 'a-R1', originalOrderId: 'a', amount: 3_000, method: 'QRIS', approverId: 'hendra' } }, at(D2, '12:00:00'), 'sari');
  // void dan karyawan: tidak dibukukan
  s.pos({ type: 'order.created', payload: { orderId: 'v', orderType: 'TAKE_AWAY' } }, at(D2, '13:00:00'), 'sari');
  s.pos({ type: 'payment.received', payload: { orderId: 'v', method: 'CASH', amount: 50_000 } }, at(D2, '13:01:00'), 'sari');
  s.pos({ type: 'void.approved', payload: { orderId: 'v', reasonCode: 'WRONG_ORDER', approverIds: ['hendra'], amount: 50_000 } }, at(D2, '13:05:00'), 'sari');
  s.pos({ type: 'order.created', payload: { orderId: 'e', orderType: 'EMPLOYEE', employeeId: 'andi' } }, at(D2, '14:00:00'), 'sari');
  s.pos({ type: 'payment.received', payload: { orderId: 'e', method: 'CASH', amount: 9_000 } }, at(D2, '14:01:00'), 'sari');
  // tutup shift hari 2: terhitung 140.000, seharusnya (menurut server) 150.000 → kekurangan 10.000
  s.pos({ type: 'cash.counted', payload: { shiftId: 'S1', counted: 140_000, expected: 140_000 } }, at(D2, '21:00:00'), 'budi');
  return s;
}

describe('jurnal penjualan harian', () => {
  it('rincian tagihan dibukukan: penerimaan per metode, penjualan, diskon, service, pajak, pembulatan; setiap jurnal seimbang', () => {
    const [d1] = journal(sample());
    expect(d1).toMatchObject({ ref: 'JU-POS-o1-20261001', date: D1, source: 'POS', memo: 'Penjualan POS 2026-10-01' });
    expect(line(d1!, SYSTEM.cash)).toEqual({ account: '1-1100', debit: 54_500 + 24_500, credit: 0 });
    expect(line(d1!, SYSTEM.digital)).toEqual({ account: '1-1200', debit: 50_000, credit: 0 });
    expect(line(d1!, SYSTEM.sales)).toEqual({ account: '4-1000', debit: 0, credit: 122_300 });
    expect(line(d1!, SYSTEM.discount)).toEqual({ account: '4-2000', debit: 10_000, credit: 0 });
    expect(line(d1!, SYSTEM.service)).toEqual({ account: '4-1100', debit: 0, credit: 5_000 });
    expect(line(d1!, SYSTEM.taxPayable)).toEqual({ account: '2-1200', debit: 0, credit: 11_730 });
    expect(line(d1!, SYSTEM.rounding)).toEqual({ account: '4-9000', debit: 30, credit: 0 });
    expect(d1!.notes).toBeUndefined();
    for (const e of journal(sample())) expect(sumDebit(e.lines)).toBe(sumCredit(e.lines));
  });

  it('hari kedua: order tanpa rincian seluruhnya Penjualan (dengan catatan), refund ke Retur dan piutang digital, void dan karyawan tidak dibukukan, kekurangan kas', () => {
    const [, d2] = journal(sample());
    expect(d2!.notes).toEqual(['ada order tanpa rincian tagihan (terminal versi lama): pajak dan service tidak dipisah']);
    expect(line(d2!, SYSTEM.sales)).toEqual({ account: '4-1000', debit: 0, credit: 33_000 });
    expect(line(d2!, SYSTEM.returns)).toEqual({ account: '4-3000', debit: 3_000, credit: 0 });
    expect(line(d2!, SYSTEM.digital)).toEqual({ account: '1-1200', debit: 33_000, credit: 3_000 });
  });

  it('selisih kas memakai angka server bila terverifikasi, dan jurnal tetap seimbang', () => {
    const s = sample();
    const cc = s.events.find((e) => e.type === 'cash.counted')!;
    const withServer = journal(s, D1, D2, [{ deviceId: cc.deviceId, seq: cc.seq, claimed: 140_000, serverExpected: 150_000 }]);
    const d2 = withServer[1]!;
    expect(line(d2, SYSTEM.cashShortage)).toEqual({ account: '6-9000', debit: 10_000, credit: 0 });
    expect(line(d2, SYSTEM.cash)).toEqual({ account: '1-1100', debit: 0, credit: 10_000 });
    expect(sumDebit(d2.lines)).toBe(sumCredit(d2.lines));
    // tanpa verifikasi server: selisih menurut terminal (0) tidak menghasilkan baris
    expect(line(journal(s)[1]!, SYSTEM.cashShortage)).toBeUndefined();
  });

  it('kelebihan kas membalik arahnya; hari tanpa kejadian tidak punya jurnal; rentang menyaring', () => {
    const s = new Sim('o1', D1, 'term-1', 'sensor-1');
    s.pos({ type: 'cash.counted', payload: { shiftId: 'S1', counted: 105_000, expected: 100_000 } }, at(D1, '21:00:00'), 'budi');
    const [e] = journal(s, D1, '2026-10-03');
    expect(e!.lines).toEqual([{ account: '1-1100', debit: 5_000, credit: 0 }, { account: '6-9000', debit: 0, credit: 5_000 }]);
    expect(journal(s, '2026-10-02', '2026-10-03')).toEqual([]);
    expect(journal(sample(), D2, D2).map((x) => x.date)).toEqual([D2]);
  });

  it('order yang baru terbayar sebagian dibukukan sebagai Penjualan seluruh penerimaan dengan catatan', () => {
    const s = new Sim('o1', D1, 'term-1', 'sensor-1');
    s.pos({ type: 'order.created', payload: { orderId: 'p', orderType: 'DINE_IN' } }, at(D1, '10:00:00'), 'budi');
    s.pos({ type: 'bill.printed', payload: { orderId: 'p', total: 100_000, breakdown: { subtotal: 100_000, discount: 0, service: 0, tax: 0, rounding: 0 } } }, at(D1, '10:01:00'), 'budi');
    s.pos({ type: 'payment.received', payload: { orderId: 'p', method: 'CASH', amount: 40_000 } }, at(D1, '10:02:00'), 'budi');
    const [e] = journal(s, D1, D1);
    expect(e!.lines).toEqual([{ account: '1-1100', debit: 40_000, credit: 0 }, { account: '4-1000', debit: 0, credit: 40_000 }]);
    expect(e!.notes![0]).toContain('sebagian');
  });
});

describe('laporan dari jurnal', () => {
  const entries = (): JournalEntry[] => [
    ...journal(sample()),
    { ref: 'JM-1', date: D2, memo: 'Sewa Oktober', source: 'MANUAL', lines: [{ account: '6-2000', debit: 3_000_000, credit: 0 }, { account: '1-1100', debit: 0, credit: 3_000_000 }] },
  ];

  it('neraca saldo seimbang; saldo menurut sisi normal akun', () => {
    const tb = trialBalance(entries(), DEFAULT_ACCOUNTS);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.rows.find((r) => r.account === '1-1100')).toMatchObject({ debit: 79_000, credit: 3_000_000, balance: 79_000 - 3_000_000 });
    expect(tb.rows.find((r) => r.account === '4-2000')).toMatchObject({ debit: 10_000, credit: 0, balance: 10_000 }); // kontra pendapatan: normal debit
    expect(tb.rows.find((r) => r.account === '2-1200')).toMatchObject({ balance: 11_730 });
    expect(tb.rows.map((r) => r.account)).toEqual([...tb.rows.map((r) => r.account)].sort());
  });

  it('laba rugi: pendapatan bersih dikurangi diskon, retur, pembulatan; beban termasuk sewa; PBJT bukan pendapatan', () => {
    const is = incomeStatement(entries(), DEFAULT_ACCOUNTS);
    // penjualan 122.300 + 33.000 + service 5.000 − diskon 10.000 − retur 3.000 − pembulatan 30
    expect(is.totalRevenue).toBe(122_300 + 33_000 + 5_000 - 10_000 - 3_000 - 30);
    expect(is.expenses.map((r) => [r.account, r.balance])).toEqual([['6-2000', 3_000_000]]);
    expect(is.netIncome).toBe(is.totalRevenue - 3_000_000);
    expect(is.revenue.some((r) => r.account === '2-1200')).toBe(false);
  });

  it('buku besar: mutasi berurutan dengan saldo berjalan', () => {
    const kas = DEFAULT_ACCOUNTS.find((a) => a.code === '1-1100')!;
    const l = ledger(entries(), kas);
    expect(l.map((x) => [x.date, x.ref, x.debit, x.credit, x.balance])).toEqual([
      [D1, 'JU-POS-o1-20261001', 79_000, 0, 79_000],
      [D2, 'JM-1', 0, 3_000_000, 79_000 - 3_000_000],
    ]);
  });

  it('CSV jurnal: satu baris per baris jurnal, terurut tanggal', () => {
    const c = journalCsvRows(entries(), DEFAULT_ACCOUNTS);
    expect(c.header).toEqual(['Tanggal', 'No Bukti', 'Kode Akun', 'Nama Akun', 'Debit', 'Kredit', 'Memo']);
    expect(c.rows[0]).toEqual([D1, 'JU-POS-o1-20261001', '1-1100', 'Kas', 79_000, 0, 'Penjualan POS 2026-10-01']);
    expect(c.rows.every((r) => r.length === 7)).toBe(true);
    const dates = c.rows.map((r) => r[0] as string);
    expect(dates).toEqual([...dates].sort());
  });
});

describe('checkJournalLines', () => {
  const accs = new Map([['1-1100', { active: true }], ['6-2000', { active: true }], ['9-9999', { active: false }]]);
  const ok = [{ account: '6-2000', debit: 100, credit: 0 }, { account: '1-1100', debit: 0, credit: 100 }];

  it('jurnal seimbang diterima', () => expect(checkJournalLines(ok, accs)).toBeNull());

  it.each([
    [[ok[0]], 'minimal dua'],
    ['bukan daftar', 'minimal dua'],
    [[{ account: '6-2000', debit: 100, credit: 0 }, { account: '1-1100', debit: 0, credit: 90 }], 'tidak seimbang'],
    [[{ account: 'x', debit: 1, credit: 0 }, ok[1]], 'tidak ada'],
    [[{ account: '9-9999', debit: 100, credit: 0 }, ok[1]], 'tidak aktif'],
    [[{ account: '6-2000', debit: 100, credit: 100 }, { account: '1-1100', debit: 0, credit: 0 }], 'salah satu'],
    [[{ account: '6-2000', debit: 0, credit: 0 }, ok[1]], 'salah satu'],
    [[{ account: '6-2000', debit: 1.5, credit: 0 }, { account: '1-1100', debit: 0, credit: 1.5 }], 'bilangan bulat'],
    [[{ account: '6-2000', debit: -100, credit: 0 }, { account: '1-1100', debit: 0, credit: -100 }], 'bilangan bulat'],
    [Array.from({ length: 31 }, (_, i) => ({ account: '6-2000', debit: i % 2 ? 0 : 1, credit: i % 2 ? 1 : 0 })), 'maksimal 30'],
  ])('menolak %j', (lines, msg) => expect(checkJournalLines(lines, accs)).toContain(msg));
});

import { buildChannelJournal } from '../src/accounting';

describe('jurnal penyelesaian platform', () => {
  it('piutang platform dilunasi dana bank dan beban komisi; seimbang per hari', () => {
    const j = buildChannelJournal([
      { date: D1, gross: 45_000, commission: 9_000, net: 36_000 }, { date: D1, gross: 30_000, commission: 6_000, net: 24_000 }, { date: D2, gross: 50_000, commission: 12_500, net: 37_500 },
    ], 'o1');
    expect(j.map((e) => e.ref)).toEqual(['JU-PLT-o1-20261001', 'JU-PLT-o1-20261002']);
    expect(j[0]!.lines).toEqual([{ account: '1-1210', debit: 0, credit: 75_000 }, { account: '1-1300', debit: 60_000, credit: 0 }, { account: '6-5100', debit: 15_000, credit: 0 }]);
    expect(j[0]!.memo).toContain('2 pesanan');
    for (const e of j) expect(sumDebit(e.lines)).toBe(sumCredit(e.lines));
    expect(j[0]!.notes).toBeUndefined();
  });

  it('potongan lain di luar komisi tercatat tetap seimbang dengan catatan', () => {
    const [e] = buildChannelJournal([{ date: D1, gross: 50_000, commission: 5_000, net: 40_000 }], 'o1');
    expect(line(e!, '6-5100')).toEqual({ account: '6-5100', debit: 10_000, credit: 0 });
    expect(sumDebit(e!.lines)).toBe(sumCredit(e!.lines));
    expect(e!.notes).toHaveLength(1);
  });

  it('pembayaran Platform di POS masuk Piutang Platform, bukan kas', () => {
    const s = new Sim('o1', D1, 'term-1', 'sensor-1');
    s.pos({ type: 'order.created', payload: { orderId: 'g', orderType: 'TAKE_AWAY' } }, at(D1, '10:00:00'), 'budi');
    s.pos({ type: 'order.channel_linked', payload: { orderId: 'g', channel: 'GOFOOD', ref: 'GF-1' } }, at(D1, '10:00:10'), 'budi');
    s.pos({ type: 'bill.printed', payload: { orderId: 'g', total: 49_500, breakdown: { subtotal: 45_000, discount: 0, service: 0, tax: 4_500, rounding: 0 } } }, at(D1, '10:01:00'), 'budi');
    s.pos({ type: 'payment.received', payload: { orderId: 'g', method: 'PLATFORM', amount: 49_500 } }, at(D1, '10:02:00'), 'budi');
    const [e] = journal(s, D1, D1);
    expect(line(e!, '1-1210')).toEqual({ account: '1-1210', debit: 49_500, credit: 0 });
    expect(line(e!, '1-1100')).toBeUndefined();
    expect(sumDebit(e!.lines)).toBe(sumCredit(e!.lines));
  });
});
