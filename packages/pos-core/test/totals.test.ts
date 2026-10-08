import { describe, expect, it } from 'vitest';
import { computeTotals, type CartLine } from '../src';

const line = (qty: number, unitPrice: number): CartLine => ({ itemId: 'x', name: 'X', qty, unitPrice, sentQty: 0 });

describe('hitung total: diskon, service charge, pajak, pembulatan', () => {
  const items = [line(2, 22_000)]; // subtotal 44.000

  it('tanpa service dan pembulatan sama dengan perilaku lama (pajak atas subtotal − diskon)', () => {
    expect(computeTotals(items, 0, 10)).toEqual({ subtotal: 44_000, discount: 0, service: 0, tax: 4_400, rounding: 0, total: 48_400 });
    expect(computeTotals(items, 4_400, { taxPercent: 10 })).toMatchObject({ tax: 3_960, total: 43_560 });
  });

  it('service 5% dan pajak 10% atas (dasar + service); diskon 4.400; pembulatan ke Rp 500', () => {
    // dasar 39.600; service 1.980; pajak (39.600 + 1.980) × 10% = 4.158; sebelum bulat 45.738 → 45.500 (−238)
    expect(computeTotals(items, 4_400, { taxPercent: 10, servicePercent: 5, roundingUnit: 500 })).toEqual({
      subtotal: 44_000, discount: 4_400, service: 1_980, tax: 4_158, rounding: -238, total: 45_500,
    });
  });

  it('pajak TIDAK atas service (taxOnService false): pajak 3.960; sebelum bulat 45.540 → Rp 100 terdekat 45.500 (−40)', () => {
    expect(computeTotals(items, 4_400, { taxPercent: 10, servicePercent: 5, taxOnService: false, roundingUnit: 100 })).toMatchObject({
      service: 1_980, tax: 3_960, rounding: -40, total: 45_500,
    });
  });

  it('pembulatan tepat di tengah dibulatkan ke atas, dan hasilnya bisa positif', () => {
    // 45.250 / 500 = 90,5 → 91 → 45.500 (+250)
    const t = computeTotals([line(1, 41_136)], 0, { taxPercent: 10, servicePercent: 0, roundingUnit: 500 }); // 41.136 + 4.114 = 45.250
    expect(t).toMatchObject({ rounding: 250, total: 45_500 });
  });

  it('jumlah komponen selalu sama dengan total; diskon melebihi subtotal tidak membuat total negatif', () => {
    for (const [d, sp, tp, ru] of [[0, 0, 11, 0], [1_234, 7, 11, 100], [10_000, 12, 10, 1000], [44_000, 5, 10, 500], [99_999, 5, 10, 500]] as const) {
      const t = computeTotals(items, d, { taxPercent: tp, servicePercent: sp, roundingUnit: ru });
      expect(t.total, JSON.stringify([d, sp, tp, ru])).toBe(Math.max(0, t.subtotal - t.discount) + t.service + t.tax + t.rounding);
      expect(t.total).toBeGreaterThanOrEqual(0);
      if (ru > 0) expect(t.total % ru).toBe(0);
    }
  });
});
