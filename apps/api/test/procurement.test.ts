import { describe, expect, it } from 'vitest';
import { checkPoLines, lineAmount, priceExceeds, weightedAvgCost } from '../src/procurement';

describe('weightedAvgCost', () => {
  it('menggabungkan stok yang ada dengan pembelian baru menurut jumlah', () => {
    expect(weightedAvgCost(1000, 80, 1000, 100)).toBe(90);
    expect(weightedAvgCost(3000, 80, 1000, 120)).toBe(90);
    expect(weightedAvgCost(500, 0.12, 2000, 0.15)).toBe(0.144);
  });
  it('stok tidak diketahui, habis, negatif, atau tanpa harga lama: harga pembelian terakhir', () => {
    expect(weightedAvgCost(null, 80, 1000, 100)).toBe(100);
    expect(weightedAvgCost(0, 80, 1000, 100)).toBe(100);
    expect(weightedAvgCost(-50, 80, 1000, 100)).toBe(100);
    expect(weightedAvgCost(1000, 0, 1000, 100)).toBe(100);
  });
  it('pembulatan empat desimal', () => {
    expect(weightedAvgCost(1, 1, 2, 1.00005)).toBe(1.0000);
    expect(weightedAvgCost(3, 0.3333, 7, 0.1234)).toBe(0.1864);
  });
});

describe('priceExceeds dan lineAmount', () => {
  it('toleransi 5% di atas harga PO; lebih murah tidak ditandai', () => {
    expect(priceExceeds(100, 105)).toBe(false);
    expect(priceExceeds(100, 105.01)).toBe(true);
    expect(priceExceeds(100, 80)).toBe(false);
    expect(priceExceeds(0, 0.1)).toBe(true);
    expect(priceExceeds(0, 0)).toBe(false);
  });
  it('nilai baris dibulatkan ke rupiah', () => {
    expect(lineAmount(1500, 0.0833)).toBe(125);
    expect(lineAmount(2000, 85)).toBe(170_000);
  });
});

describe('checkPoLines', () => {
  const ing = new Map([['kopi', { active: true }], ['susu', { active: true }], ['lama', { active: false }]]);
  const ok = [{ ingredientId: 'kopi', qty: 5000, unitCost: 0.12 }, { ingredientId: 'susu', qty: 10_000, unitCost: 0.015 }];
  it('baris sah diterima', () => expect(checkPoLines(ok, ing)).toBeNull());
  it.each([
    [[], 'minimal satu'], ['x', 'minimal satu'],
    [[{ ingredientId: 'ada-tidak', qty: 1, unitCost: 1 }], 'tidak ada'],
    [[{ ingredientId: 'lama', qty: 1, unitCost: 1 }], 'nonaktif'],
    [[ok[0], ok[0]], 'dua kali'],
    [[{ ingredientId: 'kopi', qty: 0, unitCost: 1 }], 'jumlah'],
    [[{ ingredientId: 'kopi', qty: 1.5, unitCost: 1 }], 'jumlah'],
    [[{ ingredientId: 'kopi', qty: 1, unitCost: -1 }], 'harga satuan'],
    [[{ ingredientId: 'kopi', qty: 1, unitCost: 0.00001 }], 'harga satuan'],
    [[{ ingredientId: 'kopi', qty: 1, unitCost: '10' }], 'harga satuan'],
    [[{ ingredientId: 'kopi', qty: 1, unitCost: 1e9 }], 'harga satuan'],
    [Array.from({ length: 101 }, (_, i) => ({ ingredientId: `b${i}`, qty: 1, unitCost: 1 })), 'maksimal 100'],
  ])('menolak %j', (lines, msg) => expect(checkPoLines(lines, ing)).toContain(msg));
});
