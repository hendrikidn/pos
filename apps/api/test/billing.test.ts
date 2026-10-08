import { describe, expect, it } from 'vitest';
import { addMonths, BILL_AHEAD_DAYS, billingDate, dueDateFor, GRACE_DAYS, invoiceNumber, periodOf, periodsToIssue, subscriptionStatus, type InvoiceLite } from '../src/billing';

describe('addMonths dan periodOf', () => {
  it('hari jangkar dipertahankan, dipotong ke akhir bulan tanpa menggeser periode berikutnya', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonths('2026-12-31', 1)).toBe('2027-01-31');
    expect(addMonths('2026-10-08', 0)).toBe('2026-10-08');
  });

  it('periode berurutan tanpa celah dan tanpa tumpang tindih', () => {
    const anchor = '2026-01-31';
    for (let k = 0; k < 14; k++) {
      const a = periodOf(anchor, k);
      const b = periodOf(anchor, k + 1);
      expect(Date.parse(b.start) - Date.parse(a.end)).toBe(86_400_000);
      expect(a.start <= a.end).toBe(true);
    }
    expect(periodOf('2026-10-23', 0)).toEqual({ start: '2026-10-23', end: '2026-11-22' });
  });
});

describe('periodsToIssue', () => {
  it('menerbitkan periode yang awalnya paling lambat 7 hari lagi; mulai dari periode berikutnya', () => {
    const anchor = '2026-10-23';
    expect(periodsToIssue(anchor, '2026-10-15', 0)).toEqual([]); // 8 hari sebelum awal
    expect(periodsToIssue(anchor, '2026-10-16', 0)).toEqual([0]);
    expect(periodsToIssue(anchor, '2026-10-16', 1)).toEqual([]);
    expect(periodsToIssue(anchor, '2026-11-16', 0)).toEqual([0, 1]);
    expect(BILL_AHEAD_DAYS).toBe(7);
  });

  it('tertinggal berbulan-bulan: semua periode yang terlewat ikut, dibatasi 24', () => {
    expect(periodsToIssue('2026-01-01', '2026-04-10', 0)).toEqual([0, 1, 2, 3]);
    expect(periodsToIssue('2020-01-01', '2026-04-10', 0)).toHaveLength(24);
  });
});

describe('subscriptionStatus', () => {
  const inv = (status: InvoiceLite['status'], periodStart: string, periodEnd: string, dueDate: string): InvoiceLite => ({ status, periodStart, periodEnd, dueDate });
  const trial = { status: 'TRIAL' as const, trialEnd: '2026-10-22' };

  it('masa uji coba tanpa tagihan; selesai tanpa tagihan lunas = menunggu bayar', () => {
    expect(subscriptionStatus(trial, [], '2026-10-10')).toBe('TRIAL');
    expect(subscriptionStatus(trial, [], '2026-10-22')).toBe('TRIAL');
    expect(subscriptionStatus(trial, [inv('ISSUED', '2026-10-23', '2026-11-22', '2026-10-23')], '2026-10-20')).toBe('TRIAL'); // tagihan sudah terbit tetapi masih uji coba
    expect(subscriptionStatus(trial, [inv('ISSUED', '2026-10-23', '2026-11-22', '2026-10-23')], '2026-10-24')).toBe('DUE');
  });

  it('lunas dan tercakup = aktif; periode habis tanpa tagihan baru = menunggu', () => {
    const paid = inv('PAID', '2026-10-23', '2026-11-22', '2026-10-23');
    expect(subscriptionStatus(trial, [paid], '2026-11-01')).toBe('ACTIVE');
    expect(subscriptionStatus(trial, [paid], '2026-11-22')).toBe('ACTIVE');
    expect(subscriptionStatus(trial, [paid], '2026-11-23')).toBe('DUE');
  });

  it('tertunggak hanya setelah jatuh tempo + masa tenggang; tagihan batal tidak dihitung; dibatalkan mengalahkan semuanya', () => {
    const issued = inv('ISSUED', '2026-11-23', '2026-12-22', '2026-11-23');
    const paidPrev = inv('PAID', '2026-10-23', '2026-11-22', '2026-10-23');
    expect(subscriptionStatus(trial, [paidPrev, issued], '2026-11-23')).toBe('DUE');
    expect(subscriptionStatus(trial, [paidPrev, issued], '2026-11-30')).toBe('DUE'); // tepat di batas tenggang
    expect(subscriptionStatus(trial, [paidPrev, issued], '2026-12-01')).toBe('OVERDUE');
    expect(subscriptionStatus(trial, [paidPrev, { ...issued, status: 'VOID' }], '2026-12-15')).toBe('DUE');
    expect(subscriptionStatus({ ...trial, status: 'CANCELED' }, [issued], '2026-12-15')).toBe('CANCELED');
    expect(GRACE_DAYS).toBe(7);
  });
});

describe('tanggal dan nomor', () => {
  it('jatuh tempo: awal periode, tetapi paling cepat 7 hari sejak terbit', () => {
    expect(dueDateFor('2026-11-23', '2026-11-16')).toBe('2026-11-23');
    expect(dueDateFor('2026-11-23', '2026-11-20')).toBe('2026-11-27');
    expect(dueDateFor('2026-11-23', '2026-12-10')).toBe('2026-12-17');
  });
  it('tanggal penagihan memakai WIB; nomor faktur berurutan per bulan terbit', () => {
    expect(billingDate(Date.parse('2026-10-08T17:30:00Z'))).toBe('2026-10-09');
    expect(invoiceNumber('2026-10-09', 7)).toBe('INV-202610-0007');
  });
});
