import { describe, expect, it } from 'vitest';
import {
  correctionHits, invoiceExcess, isReduction, paperUsage, priceOutlier, shortageValue, type Correction,
} from '../src/integrity';

const H = 3_600_000;
const D = 24 * H;

describe('R51: faktur di atas PO', () => {
  const line = (unitCost: number, poUnitCost: number, qty = 1000) => ({ ingredientId: 'x', name: 'Wagyu', qty, unitCost, poUnitCost });
  it('menandai bila lebih dari 5% dan nilai kelebihan minimal Rp10.000', () => {
    expect(invoiceExcess([line(120, 100)])).toMatchObject({ excess: 20_000 });
    expect(invoiceExcess([line(105, 100)])).toBeNull(); // tepat 5%: wajar
    expect(invoiceExcess([line(104, 100, 100_000)])).toBeNull(); // di dalam toleransi 5% walau nilainya besar (Rp400.000)
    expect(invoiceExcess([line(110, 100, 50)])).toBeNull(); // 500: di bawah minimum
    expect(invoiceExcess([line(90, 100)])).toBeNull(); // lebih murah
  });
  it('menjumlah beberapa baris yang melewati toleransi dan menyebut yang bermasalah saja', () => {
    const r = invoiceExcess([line(110, 100, 600), { ...line(100, 100), name: 'Aman' }, { ...line(130, 100, 200), name: 'Mahal' }]);
    expect(r!.excess).toBe(6_000 + 6_000);
    expect(r!.detail).toContain('Wagyu');
    expect(r!.detail).toContain('Mahal');
    expect(r!.detail).not.toContain('Aman');
  });
});

describe('R50: harga jauh di atas supplier lain', () => {
  const l = { qty: 1000, unitCost: 120, name: 'Wagyu' };
  it('lebih dari 15% di atas harga terendah supplier lain dan bernilai minimal Rp20.000', () => {
    expect(priceOutlier(l, 'a', { supplierId: 'b', unitCost: 100 })?.excess).toBe(20_000);
    expect(priceOutlier(l, 'a', { supplierId: 'b', unitCost: 105 })).toBeNull(); // hanya 14%
    expect(priceOutlier({ ...l, qty: 100 }, 'a', { supplierId: 'b', unitCost: 100 })).toBeNull(); // nilai kecil
  });
  it('tanpa pembanding, atau pembandingnya supplier sendiri: tidak ditandai; catatan memuat kedua supplier', () => {
    expect(priceOutlier(l, 'a', null)).toBeNull();
    expect(priceOutlier(l, 'a', { supplierId: 'a', unitCost: 100 })).toBeNull();
    expect(priceOutlier(l, 'a', { supplierId: 'b', unitCost: 100 })!.note).toContain('b menjual 100');
  });
});

describe('R15: selisih opname bernilai', () => {
  it('kurang, melewati 5% pemakaian, dan nilai minimal Rp25.000', () => {
    expect(shortageValue({ variance: -500, periodUsed: 1000 }, 100)).toBe(50_000);
    expect(shortageValue({ variance: -50, periodUsed: 1000 }, 1000)).toBeNull(); // tepat 5%: dalam toleransi
    expect(shortageValue({ variance: -51, periodUsed: 1000 }, 1000)).toBe(51_000);
    expect(shortageValue({ variance: -300, periodUsed: 100 }, 10)).toBeNull(); // nilai Rp3.000
    expect(shortageValue({ variance: 500, periodUsed: 100 }, 100)).toBeNull(); // kelebihan bukan kehilangan
  });
});

describe('R52: pengurangan resep', () => {
  it('dikurangi minimal 20% atau dihapus; penambahan dan perubahan kecil tidak', () => {
    expect(isReduction(18, 14)).toBe(true); // 22%
    expect(isReduction(18, 15)).toBe(false); // 17%
    expect(isReduction(18, 0)).toBe(true);
    expect(isReduction(0, 10)).toBe(false);
    expect(isReduction(10, 12)).toBe(false);
    expect(isReduction(10, 8)).toBe(true); // tepat 20%
  });
});

describe('R16: pemakaian gulungan kertas', () => {
  it('terpakai jauh di atas perkiraan dari cetakan: ditandai', () => {
    // 3.000 cetakan × 15 cm = 450 m = 18 gulungan (25 m)
    expect(paperUsage(10, 2, 15, 3000)).toMatchObject({ consumed: 23, flagged: false }); // wajar-ish: 23 ≤ 18×1,6+1 = 29,8
    expect(paperUsage(10, 0, 20, 3000)).toMatchObject({ consumed: 30, flagged: true });
    expect(paperUsage(10, 2, 0, 100)).toMatchObject({ consumed: 8, flagged: true }); // 100 cetakan hanya 0,6 gulungan
  });
  it('terpakai kurang dari 3 gulungan tidak pernah ditandai', () => {
    expect(paperUsage(5, 3, 0, 0).flagged).toBe(false);
  });
});

describe('R53: koreksi absen', () => {
  const c = (id: number, day: number, hours = 8, staffId = 'budi', by = 'rina'): Correction => ({ id, staffId, staffName: 'Budi', startMs: 100 * D + day * D, endMs: 100 * D + day * D + hours * H, createdBy: by });
  it('lebih dari 3 koreksi dalam 14 hari: ditandai mulai koreksi ke-4', () => {
    const hits = correctionHits([c(1, 0), c(2, 2), c(3, 4), c(4, 6)], 0);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ rule: 'R53', at: c(4, 6).endMs });
    expect(hits[0]!.note).toContain('4 koreksi');
    const more = correctionHits([c(1, 0), c(2, 2), c(3, 4), c(4, 6), c(5, 7)], 0);
    expect(more).toHaveLength(1); // koreksi tambahan memperbarui temuan yang sama, bukan membuat yang baru
    expect(more[0]!.key).toBe(hits[0]!.key);
    expect(more[0]!.note).toContain('5 koreksi');
  });
  it('tersebar lebih dari 14 hari, atau beda staf: tidak ditandai', () => {
    expect(correctionHits([c(1, 0), c(2, 8), c(3, 16), c(4, 24)], 0)).toEqual([]);
    expect(correctionHits([c(1, 0), c(2, 1, 8, 'sari'), c(3, 2, 8, 'dewi'), c(4, 3, 8, 'andi')], 0)).toEqual([]);
  });
  it('satu koreksi 10 jam atau lebih ditandai sendiri; kejadian sebelum emitFrom tidak dikeluarkan', () => {
    expect(correctionHits([c(1, 0, 13)], 0).map((h) => h.key)).toEqual(['R53:long:1']);
    expect(correctionHits([c(1, 0, 11)], 0)).toEqual([]);
    expect(correctionHits([c(1, 0, 13)], 200 * D)).toEqual([]);
  });
});
