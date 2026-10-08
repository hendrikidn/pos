import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const DAY = 86_400_000;
const NOW = WIB('2026-10-08T12:00:00');

describe('bill of material', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let manager: string;
  let ownerB: string;
  let term: string;
  const sim = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1'); // satu rantai event per terminal: dipakai bersama semua tes
  let sent = 0;
  const flush = async () => { const r = await h.postEvents(term, sim.events.slice(sent)); sent = sim.events.length; return r; };

  const post = (path: string, tok: string | undefined, body?: unknown) => h.http('POST', path, tok, body ?? {});
  const put = (path: string, tok: string, body: unknown) => h.http('PUT', path, tok, body);
  const get = (path: string, tok = owner) => h.http('GET', path, tok);
  const lines = (o: Record<string, number>) => ({ lines: Object.entries(o).map(([ingredientId, qty]) => ({ ingredientId, qty })) });
  const calc = (body: unknown, tok = owner) => post('/v1/bom/calc', tok, body);
  const stockOf = async (id: string) => ((await get('/v1/outlets/o1/stock')).body as { ingredientId: string; expected: number | null; used: number }[]).find((r) => r.ingredientId === id);

  beforeAll(async () => {
    h = await createHarness(NOW);
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    const vanila = { id: 'rasa', name: 'Rasa', min: 0, max: 1, options: [{ id: 'vanila', name: 'Vanila', price: 4000 }] };
    expect((await post('/v1/menu', owner, { id: 'latte', name: 'Latte', price: 30_000, category: 'Kopi', modifierGroups: [vanila] })).status).toBe(201);
    expect((await post('/v1/menu', owner, { id: 'sup', name: 'Sup Wortel', price: 25_000, category: 'Makanan' })).status).toBe(201);
  });
  afterAll(() => h.close());

  it('bahan: setengah jadi wajib hasil batch; susut hanya bahan baku; jenis dan satuan tidak berubah; harga turunan di daftar', async () => {
    const ing = (body: Record<string, unknown>, tok = owner) => post('/v1/ingredients', tok, body);
    expect((await ing({ id: 'gula', name: 'Gula', unit: 'g' })).status).toBe(201);
    expect((await ing({ id: 'air', name: 'Air', unit: 'ml' })).status).toBe(201);
    expect((await ing({ id: 'kopi', name: 'Kopi', unit: 'g' })).status).toBe(201);
    expect((await ing({ id: 'wortel', name: 'Wortel', unit: 'g', yieldPercent: 80 })).status).toBe(201);
    expect((await ing({ id: 'sirup', name: 'Sirup', unit: 'ml', kind: 'SEMI' })).status).toBe(400); // tanpa hasil batch
    expect((await ing({ id: 'sirup', name: 'Sirup', unit: 'ml', kind: 'SEMI', batchYield: 0 })).status).toBe(400);
    expect((await ing({ id: 'sirup', name: 'Sirup', unit: 'ml', kind: 'SEMI', batchYield: 1000, yieldPercent: 90 })).status).toBe(400); // susut bukan untuk setengah jadi
    expect((await ing({ id: 'tepung', name: 'Tepung', unit: 'g', batchYield: 500 })).status).toBe(400); // hasil batch bukan untuk bahan baku
    expect((await ing({ id: 'tepung', name: 'Tepung', unit: 'g', yieldPercent: 101 })).status).toBe(400);
    expect((await ing({ id: 'tepung', name: 'Tepung', unit: 'g', yieldPercent: 0 })).status).toBe(400);
    expect((await ing({ id: 'x1', name: 'X', unit: 'g', kind: 'ANEH' })).status).toBe(400);
    expect((await ing({ id: 'sirup', name: 'Sirup', unit: 'ml', kind: 'SEMI', batchYield: 1000 }, ops)).status).toBe(201);
    expect((await ing({ id: 'saus', name: 'Saus', unit: 'g', kind: 'SEMI', batchYield: 500 })).status).toBe(201);
    expect((await ing({ id: 'sirup', name: 'Dobel', unit: 'ml', kind: 'SEMI', batchYield: 1000 })).status).toBe(400);
    expect((await put('/v1/ingredients/sirup', owner, { kind: 'RAW' })).status).toBe(400);
    expect((await put('/v1/ingredients/wortel', owner, { batchYield: 10 })).status).toBe(400);
    expect((await put('/v1/ingredients/sirup', owner, { yieldPercent: 50 })).status).toBe(400);
    expect((await put('/v1/ingredients/wortel', owner, { yieldPercent: 150 })).status).toBe(400);
    expect((await put('/v1/ingredients/wortel', owner, { yieldPercent: 80 })).status).toBe(200);
    expect((await put('/v1/ingredients/sirup', owner, { batchYield: 1000 })).status).toBe(200);
    // harga pokok bahan baku (biasanya dari pengadaan)
    await h.db.admin.query("update ingredient set avg_cost = case id when 'gula' then 0.016 when 'air' then 0.001 when 'kopi' then 0.12 when 'wortel' then 0.01 end where id in ('gula', 'air', 'kopi', 'wortel')");
    const list = (await get('/v1/ingredients')).body as { id: string; kind: string; yieldPercent: number; batchYield: number | null; avgCost: number }[];
    expect(list.find((i) => i.id === 'wortel')).toMatchObject({ kind: 'RAW', yieldPercent: 80, batchYield: null, avgCost: 0.01 });
    expect(list.find((i) => i.id === 'sirup')).toMatchObject({ kind: 'SEMI', yieldPercent: 100, batchYield: 1000, avgCost: 0 }); // belum punya BOM
    expect((await h.db.admin.query("select detail from audit_log where action = 'ingredient.update' and detail->>'yieldTo' = '80'")).rowCount).toBe(1);
  });

  it('BOM bahan setengah jadi: hanya OWNER/OPS; validasi, siklus, kedalaman; menggantikan seluruh isi; beraudit', async () => {
    const setBom = (id: string, body: unknown, tok = owner) => put(`/v1/ingredients/${id}/bom`, tok, body);
    expect((await setBom('sirup', lines({ gula: 600, air: 500 }), manager)).status).toBe(403);
    expect((await get('/v1/boms', manager)).status).toBe(200);
    expect((await setBom('hantu', lines({ gula: 1 }))).status).toBe(404);
    expect((await setBom('gula', lines({ air: 1 }))).status).toBe(400); // bahan baku tidak punya BOM
    expect((await setBom('sirup', { lines: [] })).status).toBe(400);
    expect((await setBom('sirup', lines({ sirup: 5 }))).status).toBe(400);
    expect((await setBom('sirup', lines({ gula: 0 }))).status).toBe(400);
    expect((await setBom('sirup', lines({ hantu: 5 }))).status).toBe(400);
    expect((await setBom('sirup', lines({ gula: 600, air: 500 }), ops)).status).toBe(200);
    expect((await setBom('saus', lines({ sirup: 200, wortel: 400 }))).status).toBe(200);
    const cyc = await setBom('sirup', lines({ saus: 10 })); // saus sudah memuat sirup
    expect(cyc.status).toBe(400);
    expect(cyc.body.message).toContain('siklus');
    expect((await get('/v1/boms')).body).toEqual({ sirup: { batchYield: 1000, lines: { gula: 600, air: 500 } }, saus: { batchYield: 500, lines: { sirup: 200, wortel: 400 } } });
    expect((await setBom('sirup', lines({ gula: 700, air: 500 }))).status).toBe(200);
    expect(((await get('/v1/boms')).body as { sirup: { lines: { gula: number } } }).sirup.lines.gula).toBe(700);
    expect((await setBom('sirup', lines({ gula: 600, air: 500 }))).status).toBe(200);
    const audit = (await h.db.admin.query<{ detail: { before: object; after: object } }>("select detail from audit_log where action = 'bom.set' order by id desc limit 1")).rows[0]!.detail;
    expect(audit).toEqual({ parentId: 'sirup', before: { gula: 700, air: 500 }, after: { gula: 600, air: 500 } });
    expect((await get('/v1/boms', ownerB)).body).toEqual({}); // tenant lain tidak melihat
    // bahan baku yang dipakai BOM harus tetap sah: harga turunan muncul di daftar
    const list = (await get('/v1/ingredients')).body as { id: string; avgCost: number }[];
    expect(list.find((i) => i.id === 'sirup')!.avgCost).toBeCloseTo(0.0101, 6);
  });

  it('resep menu tidak boleh memakai bahan setengah jadi yang BOM-nya belum diisi (pemakaian bahan baku akan tak terhitung)', async () => {
    expect((await post('/v1/ingredients', owner, { id: 'kosong', name: 'Kosong', unit: 'ml', kind: 'SEMI', batchYield: 100 })).status).toBe(201);
    const r = await put('/v1/menu/sup/recipe', owner, lines({ kosong: 10 }));
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('kosong');
  });

  it('resep menu boleh memakai bahan setengah jadi; /v1/recipes memberi resep apa adanya; HPP menu memasukkan biayanya', async () => {
    expect((await put('/v1/menu/latte/recipe', owner, lines({ kopi: 18, sirup: 20 }))).status).toBe(200);
    expect((await put('/v1/menu/latte/recipe', owner, { optionId: 'vanila', ...lines({ sirup: 10 }) })).status).toBe(200);
    expect((await put('/v1/menu/sup/recipe', owner, lines({ saus: 100, wortel: 50 }))).status).toBe(200);
    expect(((await get('/v1/recipes')).body as Record<string, unknown>)['latte']).toEqual({ base: { kopi: 18, sirup: 20 }, options: { vanila: { sirup: 10 } } });
    const cost = ((await get('/v1/menu-cost')).body as { id: string; cost: number | null; margin: number }[]);
    expect(cost.find((m) => m.id === 'latte')!.cost).toBe(2); // 18×0,12 + 20×0,0101 = 2,362
    // sup: saus 100 g = (200×0,0101 + 400×0,0125)/500 × 100 = 1,404 ... + wortel 50 g terpakai ×0,0125 = 0,625 → 2,029
    expect(cost.find((m) => m.id === 'sup')!.cost).toBe(2);
  });

  it('kalkulator: kebutuhan bahan baku, biaya, margin, pohon; validasi; peran; tenant lain', async () => {
    const r = await calc({ items: [{ menuId: 'latte', qty: 10 }] });
    expect(r.status).toBe(201);
    expect(Object.fromEntries(r.body.requirements.map((x: { ingredientId: string; qty: number }) => [x.ingredientId, x.qty]))).toEqual({ air: 100, gula: 120, kopi: 180 });
    expect(r.body.totals).toEqual({ revenue: 300_000, cost: 24, margin: 299_976, marginPct: 100 });
    expect(r.body.outletId).toBeNull();
    expect(r.body.requirements[0]).not.toHaveProperty('onHand');
    const withOpt = await calc({ items: [{ menuId: 'latte', qty: 2, options: ['vanila'] }, { menuId: 'sup', qty: 4 }] });
    expect(withOpt.body.lines[0].options).toEqual(['Vanila']);
    expect(withOpt.body.lines[0].tree.find((n: { id: string }) => n.id === 'sirup').children.map((c: { id: string }) => c.id)).toEqual(['gula', 'air']);
    for (const bad of [{}, { items: [] }, { items: [{ menuId: 'latte', qty: 0 }] }, { items: [{ menuId: 'latte', qty: 1.5 }] }, { items: [{ menuId: 'latte', qty: 200_000 }] }, { items: [{ menuId: 'hantu', qty: 1 }] },
      { items: [{ menuId: 'latte', qty: 1, options: ['coklat'] }] }, { items: [{ menuId: 5, qty: 1 }] }, { items: Array.from({ length: 51 }, () => ({ menuId: 'latte', qty: 1 })) }, { items: [{ menuId: 'latte', qty: 1 }], outletId: 5 }]) {
      expect((await calc(bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    expect((await calc({ items: [{ menuId: 'latte', qty: 1 }], outletId: 'hantu' })).status).toBe(404);
    expect((await calc({ items: [{ menuId: 'latte', qty: 1 }] }, manager)).status).toBe(201);
    expect((await calc({ items: [{ menuId: 'latte', qty: 1 }] }, term)).status).toBe(403);
    expect((await calc({ items: [{ menuId: 'latte', qty: 1 }] }, ownerB)).status).toBe(400); // menu milik tenant lain tidak terlihat
    expect((await calc({ items: [{ menuId: 'latte', qty: 1 }], outletId: 'o1' }, ownerB)).status).toBe(404);
  });

  it('stok: bahan setengah jadi tidak punya stok; penjualan mengurangi bahan baku hasil uraian dan susut', async () => {
    const mv = (body: Record<string, unknown>) => post('/v1/outlets/o1/stock/movements', owner, body);
    expect((await mv({ ingredientId: 'sirup', kind: 'COUNT', qty: 100 })).status).toBe(400);
    for (const [ingredientId, qty] of [['gula', 5_000], ['air', 5_000], ['kopi', 2_000], ['wortel', 3_000]] as const) expect((await mv({ ingredientId, kind: 'COUNT', qty })).status).toBe(201);
    expect(((await get('/v1/outlets/o1/stock')).body as { ingredientId: string }[]).map((r) => r.ingredientId).sort()).toEqual(['air', 'gula', 'kopi', 'wortel']); // tanpa sirup/saus
    // 3 latte + 2 sup, dijual setelah hitung fisik
    const item = (itemId: string, name: string, qty: number, unitPrice: number, options?: { id: string; group: string; name: string; price: number }[]) => ({ itemId, name, qty, unitPrice, ...(options ? { options } : {}) });
    h.setNow(NOW + 60_000);
    sim.cashOrder('s1', NOW + 120_000, NOW + 180_000, 90_000, 'budi', [item('latte', 'Latte', 3, 30_000)]);
    sim.cashOrder('s2', NOW + 240_000, NOW + 300_000, 50_000, 'budi', [item('sup', 'Sup Wortel', 2, 25_000)]);
    expect((await flush()).status).toBe(201);
    h.setNow(NOW + 600_000);
    // latte ×3: kopi 54, sirup 60 ml → gula 36, air 30. sup ×2: saus 200 g → gula 200×0,4×0,6 = 48, air 40, wortel 200×0,8×1,25 = 200; wortel langsung 100 g/0,8 = 125
    expect(await stockOf('kopi')).toMatchObject({ used: 54, expected: 1946 });
    expect(await stockOf('gula')).toMatchObject({ used: 36 + 48, expected: 5000 - 84 });
    expect(await stockOf('air')).toMatchObject({ used: 30 + 40, expected: 4930 });
    expect(await stockOf('wortel')).toMatchObject({ used: 200 + 125, expected: 3000 - 325 });
  });

  it('pembelian dan transfer hanya bahan baku', async () => {
    expect((await post('/v1/suppliers', owner, { id: 'pasok', name: 'CV Pasok' })).status).toBe(201);
    const po = await post('/v1/purchase-orders', owner, { outletId: 'o1', supplierId: 'pasok', lines: [{ ingredientId: 'sirup', qty: 1000, unitCost: 10 }] });
    expect(po.status).toBe(400);
    expect(po.body.message).toContain('sirup');
    expect((await post('/v1/purchase-orders', owner, { outletId: 'o1', supplierId: 'pasok', lines: [{ ingredientId: 'gula', qty: 1000, unitCost: 16 }] })).status).toBe(201);
  });

  it('kalkulator dengan outlet: stok sekarang dan kekurangan', async () => {
    const r = await calc({ items: [{ menuId: 'latte', qty: 300 }], outletId: 'o1' });
    expect(r.status).toBe(201);
    const by = Object.fromEntries(r.body.requirements.map((x: { ingredientId: string }) => [x.ingredientId, x]));
    // 300 latte: kopi 5.400 g (stok 1.946), gula 3.600 g (stok 4.916), air 3.000 ml (stok 4.930)
    expect(by.kopi).toMatchObject({ qty: 5_400, onHand: 1_946, shortage: 3_454 });
    expect(by.gula).toMatchObject({ qty: 3_600, onHand: 4_916, shortage: 0 });
    expect(by.air).toMatchObject({ qty: 3_000, shortage: 0 });
  });

  it('rencana kebutuhan: rata-rata per hari buka dari riwayat, kali hari ke depan, dibanding stok; validasi', async () => {
    h.setNow(NOW + 2 * DAY);
    const latte = (qty: number) => [{ itemId: 'latte', name: 'Latte', qty, unitPrice: 30_000 }];
    // dua hari buka lagi (9 dan 10 Okt) dengan 10 latte per hari; 8 Okt sudah ada 3 latte + 2 sup
    sim.cashOrder('p1', WIB('2026-10-09T10:00:00'), WIB('2026-10-09T10:05:00'), 300_000, 'budi', latte(10));
    sim.cashOrder('p2', WIB('2026-10-10T10:00:00'), WIB('2026-10-10T10:05:00'), 300_000, 'budi', latte(10));
    expect((await flush()).status).toBe(201);
    h.setNow(WIB('2026-10-10T20:00:00'));
    const r = await get('/v1/outlets/o1/bom/plan?days=7&history=14');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outletId: 'o1', days: 7, history: 14, activeDays: 3, orders: 4 });
    const by = Object.fromEntries(r.body.rows.map((x: { ingredientId: string }) => [x.ingredientId, x]));
    // total kopi 14 hari: (3 + 10 + 10) latte × 18 = 414 g → per hari buka 138 → 7 hari 966
    expect(by.kopi).toMatchObject({ need: 966, onHand: 2000 - 54 - 360, shortage: 0 });
    expect(by.kopi.daysOfCover).toBeCloseTo(((2000 - 414) / 138), 1);
    expect(r.body.rows[0].shortage).toBeGreaterThanOrEqual(r.body.rows.at(-1).shortage);
    expect(r.body.totals.cost).toBeGreaterThan(0);
    expect((await get('/v1/outlets/o1/bom/plan?days=0')).status).toBe(400);
    expect((await get('/v1/outlets/o1/bom/plan?days=7&history=99')).status).toBe(400);
    expect((await get('/v1/outlets/o1/bom/plan?days=x')).status).toBe(400);
    expect((await get('/v1/outlets/o1/bom/plan', ownerB)).status).toBe(404);
    expect((await get('/v1/outlets/o1/bom/plan', term)).status).toBe(403);
    expect((await get('/v1/outlets/hantu/bom/plan')).status).toBe(404);
    const quiet = await get('/v1/outlets/o1/bom/plan?days=7&history=1');
    expect(quiet.body.activeDays).toBe(1); // hanya 10 Okt dalam 1 hari terakhir
  });
});
