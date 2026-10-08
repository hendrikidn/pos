import { describe, expect, it } from 'vitest';
import type { Recipes } from '@pos/order';
import { BomError, calcBom, checkBom, flattenRecipes, planNeeds, resolveIngredient, type BomDefs, type BomIngredient, type BomMenu } from '../src/bom';

const raw = (id: string, avgCost: number, over: Partial<BomIngredient> = {}): BomIngredient => ({ id, name: id.toUpperCase(), unit: 'g', kind: 'RAW', yieldPercent: 100, batchYield: null, active: true, avgCost, ...over });
const semi = (id: string, batchYield: number, unit: BomIngredient['unit'] = 'ml'): BomIngredient => ({ id, name: id.toUpperCase(), unit, kind: 'SEMI', yieldPercent: 100, batchYield, active: true, avgCost: 0 });
const ings = (...l: BomIngredient[]) => new Map(l.map((i) => [i.id, i]));
const defs = (o: Record<string, Record<string, number>>): BomDefs => new Map(Object.entries(o).map(([k, v]) => [k, new Map(Object.entries(v))]));
const recipes = (base: Record<string, Record<string, number>>, options: Record<string, Record<string, number>> = {}): Recipes => ({
  base: new Map(Object.entries(base).map(([k, v]) => [k, new Map(Object.entries(v))])),
  options: new Map(Object.entries(options).map(([k, v]) => [k, new Map(Object.entries(v))])),
});

const ING = ings(raw('gula', 0.016), raw('air', 0.001, { unit: 'ml' }), raw('kopi', 0.12), raw('wortel', 0.01, { yieldPercent: 80 }), semi('sirup', 1000), semi('saus', 500, 'g'));
const DEFS = defs({ sirup: { gula: 600, air: 500 }, saus: { sirup: 200, wortel: 400 } });
const near = (a: number, b: number, d = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(d);

describe('BOM: penguraian dan biaya', () => {
  it('bahan baku: susut menaikkan kebutuhan beli dan biaya per satuan terpakai', () => {
    const r = resolveIngredient('wortel', ING, DEFS);
    near(r.raw.get('wortel')!, 1.25); // 80% terpakai → beli 1,25 g per 1 g terpakai
    near(r.cost, 0.0125);
    expect(r.depth).toBe(0);
    expect(resolveIngredient('kopi', ING, DEFS).raw.get('kopi')).toBe(1);
  });

  it('bahan setengah jadi: biaya dan kebutuhan per satuan dari BOM per batch ÷ hasil batch', () => {
    const r = resolveIngredient('sirup', ING, DEFS);
    near(r.raw.get('gula')!, 0.6);
    near(r.raw.get('air')!, 0.5);
    near(r.cost, 0.6 * 0.016 + 0.5 * 0.001); // 0,0101 per ml
    expect(r.depth).toBe(1);
  });

  it('bertingkat: setengah jadi di dalam setengah jadi, dengan susut bahan bakunya', () => {
    const r = resolveIngredient('saus', ING, DEFS);
    near(r.raw.get('gula')!, (200 / 500) * 0.6); // 0,24 g gula per g saus
    near(r.raw.get('wortel')!, (400 / 500) * 1.25); // 1,0 g wortel dibeli per g saus
    near(r.cost, (200 * 0.0101 + 400 * 0.0125) / 500);
    expect(r.depth).toBe(2);
  });

  it('bahan tanpa harga pokok dilaporkan (biaya terlalu rendah); bahan tak dikenal, BOM kosong, hasil batch kosong ditolak', () => {
    const r = resolveIngredient('sirup', ings(raw('gula', 0), raw('air', 0.001, { unit: 'ml' }), semi('sirup', 1000)), DEFS);
    expect([...r.unpriced]).toEqual(['gula']);
    expect(() => resolveIngredient('hantu', ING, DEFS)).toThrow(BomError);
    expect(() => resolveIngredient('sirup', ING, defs({}))).toThrow(/belum punya BOM/);
    expect(() => resolveIngredient('sirup', ings(raw('gula', 1), { ...semi('sirup', 1), batchYield: null }), defs({ sirup: { gula: 1 } }))).toThrow(/hasil batch/);
  });
});

describe('BOM: pemeriksaan sebelum disimpan', () => {
  const lines = (o: Record<string, number>) => Object.entries(o).map(([ingredientId, qty]) => ({ ingredientId, qty }));
  const check = (parent: string, l: unknown, base = ING, d = DEFS) => checkBom(parent, l, base, new Map(d).set(parent, new Map(Array.isArray(l) ? (l as { ingredientId: string; qty: number }[]).filter((x) => x?.ingredientId).map((x) => [x.ingredientId, x.qty]) : [])));

  it('BOM sah diterima; hanya bahan setengah jadi yang punya BOM', () => {
    expect(check('sirup', lines({ gula: 600, air: 500 }))).toBeNull();
    expect(check('gula', lines({ air: 1 }))).toContain('setengah jadi');
    expect(check('hantu', lines({ air: 1 }))).toBe('bahan tidak ditemukan');
  });

  it('menolak: kosong, terlalu banyak, ganda, diri sendiri, tak dikenal, nonaktif, jumlah tidak sah', () => {
    expect(check('sirup', [])).toContain('1–30');
    expect(check('sirup', 'x')).toContain('1–30');
    expect(check('sirup', Array.from({ length: 31 }, (_, i) => ({ ingredientId: `b${i}`, qty: 1 })))).toContain('1–30');
    expect(check('sirup', [{ ingredientId: 'gula', qty: 1 }, { ingredientId: 'gula', qty: 2 }])).toContain('ganda');
    expect(check('sirup', lines({ sirup: 5 }))).toContain('dirinya sendiri');
    expect(check('sirup', lines({ hantu: 5 }))).toContain('tidak ditemukan');
    expect(check('sirup', lines({ gula: 5 }), ings(raw('gula', 1, { active: false }), semi('sirup', 10)))).toContain('nonaktif');
    for (const q of [0, -1, 1.5, 2_000_000]) expect(check('sirup', lines({ gula: q }))).toContain('bilangan bulat');
    expect(check('sirup', [{ qty: 1 }])).toContain('ingredientId');
  });

  it('menolak siklus (langsung maupun tak langsung) dan kedalaman lebih dari 5 tingkat', () => {
    expect(check('sirup', lines({ saus: 10 }))).toContain('siklus'); // saus memuat sirup
    const chain = ings(raw('r', 1), ...[1, 2, 3, 4, 5, 6].map((n) => semi(`s${n}`, 10)));
    const d = defs({ s1: { s2: 1 }, s2: { s3: 1 }, s3: { s4: 1 }, s4: { s5: 1 }, s5: { r: 1 } });
    expect(check('s1', lines({ s2: 1 }), chain, d)).toBeNull(); // 5 tingkat: s1→s2→s3→s4→s5→r
    expect(check('s6', lines({ s1: 1 }), chain, d)).toContain('terlalu dalam'); // 6 tingkat
  });

  it('perubahan di bagian bawah yang membuat bahan di atasnya terlalu dalam juga ditolak', () => {
    const base = ings(raw('r', 1), ...['a1', 'a2', 'a3', 'a4', 'a5', 'b'].map((id) => semi(id, 10)));
    const d = defs({ a1: { a2: 1 }, a2: { a3: 1 }, a3: { a4: 1 }, a4: { a5: 1 }, a5: { r: 1 }, b: { r: 1 } });
    expect(check('a5', lines({ r: 2 }), base, d)).toBeNull();
    expect(check('a5', lines({ b: 1 }), base, d)).toContain('terlalu dalam'); // a1 kini 6 tingkat, walau a5 sendiri hanya 2
  });

  it('perubahan yang merusak bahan setengah jadi lain (yang memakainya jadi siklus) juga ditolak', () => {
    const d = defs({ sirup: { gula: 600 }, saus: { sirup: 200 } });
    expect(check('sirup', lines({ saus: 1 }), ING, d)).toContain('siklus');
  });
});

describe('BOM: resep terurai dan kalkulator', () => {
  const MENUS = new Map<string, BomMenu>([
    ['latte', { id: 'latte', name: 'Latte', price: 30_000, options: new Map([['vanila', 'Vanila']]) }],
    ['sup', { id: 'sup', name: 'Sup Wortel', price: 25_000, options: new Map() }],
    ['air', { id: 'air', name: 'Air Putih', price: 5_000, options: new Map() }],
  ]);
  const R = recipes({ latte: { kopi: 18, sirup: 20 }, sup: { saus: 100, wortel: 50 } }, { 'latte|vanila': { sirup: 10 } });

  it('flattenRecipes: bahan setengah jadi dan susut terurai ke bahan baku; yang tak dikenal dibiarkan', () => {
    const f = flattenRecipes(recipes({ latte: { kopi: 18, sirup: 20, hantu: 3 }, sup: { wortel: 50 } }), ING, DEFS);
    const latte = f.base.get('latte')!;
    near(latte.get('kopi')!, 18);
    near(latte.get('gula')!, 12); // 20 ml × 0,6
    near(latte.get('air')!, 10);
    expect(latte.get('hantu')).toBe(3);
    near(f.base.get('sup')!.get('wortel')!, 62.5); // 50 g terpakai / 0,8
  });

  it('flattenRecipes: BOM rusak (siklus) tidak menghilangkan pemakaian', () => {
    const bad = defs({ sirup: { saus: 1 }, saus: { sirup: 1 } });
    expect(flattenRecipes(recipes({ latte: { sirup: 20 } }), ING, bad).base.get('latte')!.get('sirup')).toBe(20);
  });

  it('hitung 10 latte: kebutuhan bahan baku dibulatkan ke atas, biaya, pendapatan, margin', () => {
    const r = calcBom([{ menuId: 'latte', qty: 10 }], MENUS, R, ING, DEFS);
    const need = Object.fromEntries(r.requirements.map((x) => [x.ingredientId, x.qty]));
    expect(need).toEqual({ air: 100, gula: 120, kopi: 180 });
    // per porsi: kopi 18 × 0,12 = 2,16; sirup 20 × 0,0101 = 0,202 → 2,362; × 10 = 23,62
    expect(r.totals).toEqual({ revenue: 300_000, cost: 24, margin: 299_976, marginPct: 100 });
    expect(r.lines[0]).toMatchObject({ menuId: 'latte', name: 'Latte', qty: 10, options: [], revenue: 300_000, cost: 24 });
    expect(r.unpriced).toEqual([]);
    expect(r.noRecipe).toEqual([]);
  });

  it('opsi menambah bahan; pohon menunjukkan tingkat setengah jadi dan bahan bakunya', () => {
    const r = calcBom([{ menuId: 'latte', qty: 2, options: ['vanila'] }], MENUS, R, ING, DEFS);
    expect(Object.fromEntries(r.requirements.map((x) => [x.ingredientId, x.qty]))).toEqual({ air: 30, gula: 36, kopi: 36 }); // sirup 2×(20+10)=60 ml
    expect(r.lines[0]!.options).toEqual(['Vanila']);
    const sirup = r.lines[0]!.tree.find((n) => n.id === 'sirup')!;
    expect(sirup).toMatchObject({ kind: 'SEMI', qty: 40, unit: 'ml' });
    expect(sirup.children!.map((c) => [c.id, c.qty])).toEqual([['gula', 24], ['air', 20]]);
  });

  it('gabungan beberapa menu menjumlah kebutuhan bahan yang sama; menu tanpa resep dicatat dan tidak menyumbang', () => {
    const r = calcBom([{ menuId: 'latte', qty: 10 }, { menuId: 'sup', qty: 4 }, { menuId: 'air', qty: 3 }], MENUS, R, ING, DEFS);
    const need = Object.fromEntries(r.requirements.map((x) => [x.ingredientId, x.qty]));
    // sup 4 porsi: saus 400 g → gula 96, air 40 (dari sirup 160 ml: 0,4 × 400), wortel 400 g beli; wortel langsung 200 g terpakai → 250 beli
    expect(need['gula']).toBe(120 + 96);
    expect(need['wortel']).toBe(400 + 250);
    expect(r.noRecipe).toEqual(['Air Putih']);
    expect(r.totals.revenue).toBe(300_000 + 100_000 + 15_000);
  });

  it('bahan tanpa harga pokok ditandai; menu atau opsi tak dikenal ditolak', () => {
    const noCost = ings(raw('gula', 0), raw('air', 0.001, { unit: 'ml' }), raw('kopi', 0.12), semi('sirup', 1000));
    expect(calcBom([{ menuId: 'latte', qty: 1 }], MENUS, recipes({ latte: { kopi: 18, sirup: 20 } }), noCost, DEFS).unpriced).toEqual(['gula']);
    expect(() => calcBom([{ menuId: 'hantu', qty: 1 }], MENUS, R, ING, DEFS)).toThrow(/menu tidak ditemukan/);
    expect(() => calcBom([{ menuId: 'latte', qty: 1, options: ['coklat'] }], MENUS, R, ING, DEFS)).toThrow(/opsi coklat/);
    expect(() => calcBom([{ menuId: 'latte', qty: 1 }], MENUS, recipes({ latte: { hantu: 1 } }), ING, DEFS)).toThrow(/bahan resep tidak dikenal/);
  });
});

describe('BOM: rencana kebutuhan', () => {
  const I = ings(raw('kopi', 0.12), raw('gula', 0.016), raw('susu', 0.0175, { unit: 'ml' }));
  it('kebutuhan = rata-rata harian × hari; kekurangan terhadap stok; hari cukup; urut dari yang paling kurang', () => {
    const rows = planNeeds(new Map([['kopi', 180], ['gula', 120], ['susu', 1500]]), 7, new Map<string, number | null>([['kopi', 1000], ['gula', null], ['susu', 5000]]), I);
    expect(rows.map((r) => r.ingredientId)).toEqual(['susu', 'kopi', 'gula']);
    expect(rows[1]).toMatchObject({ need: 1260, onHand: 1000, shortage: 260, daysOfCover: 5.6 });
    expect(rows[0]).toMatchObject({ need: 10_500, shortage: 5_500, daysOfCover: 3.3 });
    expect(rows[2]).toMatchObject({ need: 840, onHand: null, shortage: 0, daysOfCover: null }); // stok tidak diketahui
    expect(rows[1]!.cost).toBe(Math.round(180 * 7 * 0.12));
  });

  it('stok negatif dihitung nol; tanpa pemakaian tidak punya hari cukup; bahan tak dikenal dilewati', () => {
    const rows = planNeeds(new Map([['kopi', 100], ['gula', 0], ['hantu', 5]]), 2, new Map([['kopi', -50], ['gula', 10]]), I);
    expect(rows.map((r) => r.ingredientId).sort()).toEqual(['gula', 'kopi']);
    expect(rows.find((r) => r.ingredientId === 'kopi')).toMatchObject({ shortage: 200, daysOfCover: 0 });
    expect(rows.find((r) => r.ingredientId === 'gula')).toMatchObject({ need: 0, shortage: 0, daysOfCover: null });
  });
});
