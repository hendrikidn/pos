import { describe, expect, it } from 'vitest';
import { buildDepositJournal, sumCredit, sumDebit } from '../src/accounting';
import { checkDepositPayment, depositRemaining, overlaps, unsettledDeadline, UNSETTLED_AFTER_MS, type ReservationFacts } from '../src/reservation';

const H = 3_600_000;
const START = Date.parse('2026-10-08T19:00:00+07:00');
const facts = (over: Partial<ReservationFacts> = {}): ReservationFacts => ({
  id: 7, status: 'SEATED', startMs: START, durationMin: 90, deposit: 200_000, depositAtMs: START - 5 * H, depositBy: 'rina', statusAtMs: null, settleKind: null, settleAtMs: null, ...over,
});

describe('reservasi: bentrok dan uang muka (murni)', () => {
  it('bentrok hanya bila rentang saling menimpa; bersentuhan di ujung tidak bentrok', () => {
    const a = { startMs: START, durationMin: 90 };
    expect(overlaps(a, { startMs: START + 60 * 60_000, durationMin: 60 })).toBe(true);
    expect(overlaps(a, { startMs: START - 30 * 60_000, durationMin: 60 })).toBe(true);
    expect(overlaps(a, { startMs: START + 90 * 60_000, durationMin: 60 })).toBe(false);
    expect(overlaps(a, { startMs: START - 60 * 60_000, durationMin: 60 })).toBe(false);
    expect(overlaps(a, { startMs: START + 10 * 60_000, durationMin: 30 })).toBe(true); // di dalam
  });

  it('sisa uang muka: dikurangi yang terpakai, nol bila sudah diselesaikan, tidak negatif', () => {
    expect(depositRemaining({ deposit: 200_000, settleKind: null }, 0)).toBe(200_000);
    expect(depositRemaining({ deposit: 200_000, settleKind: null }, 150_000)).toBe(50_000);
    expect(depositRemaining({ deposit: 200_000, settleKind: null }, 250_000)).toBe(0);
    expect(depositRemaining({ deposit: 200_000, settleKind: 'REFUND' }, 0)).toBe(0);
  });

  it('pembayaran uang muka yang sah tidak ditandai', () => {
    expect(checkDepositPayment(facts(), 0, 120_000, START + H, 7)).toBeNull();
    expect(checkDepositPayment(facts(), 120_000, 80_000, START + H, 7)).toBeNull(); // tepat habis
  });

  it('R43: reservasi tidak ada, tanpa uang muka, dipakai sebelum dicatat', () => {
    expect(checkDepositPayment(undefined, 0, 10_000, START, 99)).toContain('#99 tidak ada');
    expect(checkDepositPayment(facts({ deposit: 0, depositAtMs: null }), 0, 10_000, START, 7)).toContain('tidak punya uang muka');
    expect(checkDepositPayment(facts(), 0, 10_000, START - 6 * H, 7)).toContain('sebelum dicatat');
  });

  it('R43: tamu belum didudukkan (reservasi masih dipesan)', () => {
    expect(checkDepositPayment(facts({ status: 'BOOKED' }), 0, 10_000, START, 7)).toContain('belum didudukkan');
    expect(checkDepositPayment(facts({ status: 'SEATED', statusAtMs: START }), 0, 10_000, START + 1, 7)).toBeNull();
  });

  it('R43: sesudah dikembalikan/dihanguskan/dibatalkan, tetapi pemakaian sebelum penyelesaian tetap sah', () => {
    const refunded = facts({ settleKind: 'REFUND', settleAtMs: START + 2 * H });
    expect(checkDepositPayment(refunded, 0, 10_000, START + 3 * H, 7)).toContain('dikembalikan');
    expect(checkDepositPayment(refunded, 0, 10_000, START + H, 7)).toBeNull();
    expect(checkDepositPayment(facts({ settleKind: 'FORFEIT', settleAtMs: START }), 0, 10_000, START + 1, 7)).toContain('dihanguskan');
    expect(checkDepositPayment(facts({ status: 'CANCELED', statusAtMs: START - H }), 0, 10_000, START, 7)).toContain('dibatalkan');
    expect(checkDepositPayment(facts({ status: 'NO_SHOW', statusAtMs: START + H }), 0, 10_000, START + 2 * H, 7)).toContain('tidak datang');
  });

  it('R43: melebihi uang muka (termasuk pemakaian berulang) dan di luar jam reservasi', () => {
    expect(checkDepositPayment(facts(), 150_000, 60_000, START, 7)).toContain('melebihi');
    expect(checkDepositPayment(facts(), 0, 200_001, START, 7)).toContain('melebihi');
    expect(checkDepositPayment(facts(), 0, 10_000, START + 30 * H, 7)).toContain('di luar jam reservasi');
    expect(checkDepositPayment(facts({ depositAtMs: START - 80 * H }), 0, 10_000, START - 40 * H, 7)).toContain('di luar jam reservasi');
  });

  it('R44: tenggat 24 jam setelah selesai/dibatalkan; tidak ada bila sudah habis dipakai atau diselesaikan', () => {
    const end = START + 90 * 60_000;
    expect(unsettledDeadline(facts(), 0)).toBe(end + UNSETTLED_AFTER_MS);
    expect(unsettledDeadline(facts({ status: 'CANCELED', statusAtMs: START - 2 * H }), 0)).toBe(START - 2 * H + UNSETTLED_AFTER_MS);
    expect(unsettledDeadline(facts(), 200_000)).toBeNull();
    expect(unsettledDeadline(facts({ settleKind: 'FORFEIT', settleAtMs: START }), 0)).toBeNull();
    expect(unsettledDeadline(facts({ deposit: 0 }), 0)).toBeNull();
  });

  it('jurnal uang muka seimbang: diterima, dikembalikan, dihanguskan', () => {
    const j = buildDepositJournal([
      { id: 1, guest: 'Ani', deposit: 100_000, method: 'CASH', depositAt: '2026-10-08', settle: { kind: 'REFUND', amount: 100_000, at: '2026-10-09' } },
      { id: 2, guest: 'Budi', deposit: 50_000, method: 'TRANSFER', depositAt: '2026-10-08', settle: { kind: 'FORFEIT', amount: 50_000, at: '2026-10-10' } },
    ]);
    expect(j.map((e) => e.ref)).toEqual(['JU-UM-1', 'JU-UMX-1', 'JU-UM-2', 'JU-UMX-2']);
    for (const e of j) expect(sumDebit(e.lines)).toBe(sumCredit(e.lines));
    expect(j[1]!.lines).toEqual([{ account: '2-1300', debit: 100_000, credit: 0 }, { account: '1-1100', debit: 0, credit: 100_000 }]); // kembali ke kas
    expect(j[3]!.lines).toEqual([{ account: '2-1300', debit: 50_000, credit: 0 }, { account: '4-9100', debit: 0, credit: 50_000 }]);
    expect(j[2]!.lines[0]).toEqual({ account: '1-1300', debit: 50_000, credit: 0 }); // transfer ke bank
  });
});
