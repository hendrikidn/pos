import { describe, expect, it } from 'vitest';
import { earliestBaseline } from '../src/stock';

const c = (ingredientId: string, at: number, kind: 'COUNT' | 'PURCHASE' | 'WASTE' = 'COUNT') => ({ ingredientId, kind, at });

describe('waktu dasar pemakaian stok', () => {
  it('memakai hitung fisik TERBARU tiap bahan, lalu yang terlama di antaranya (opname lama yang sudah tergantikan tidak dibaca)', () => {
    const list = [c('biji', 100), c('biji', 5_000), c('biji', 9_000), c('susu', 200), c('susu', 7_000)];
    expect(earliestBaseline(list)).toBe(7_000); // biji 9.000, susu 7.000 → 7.000 (bukan 100)
  });

  it('pembelian dan pembuangan tidak dihitung; tanpa hitung fisik null', () => {
    expect(earliestBaseline([c('biji', 10, 'PURCHASE'), c('biji', 20, 'WASTE')])).toBeNull();
    expect(earliestBaseline([])).toBeNull();
  });

  it('ribuan pergerakan tidak membuat galat (tanpa spread ke Math.min)', () => {
    const many = Array.from({ length: 300_000 }, (_, i) => c('biji', i));
    expect(earliestBaseline(many)).toBe(299_999);
  });
});
