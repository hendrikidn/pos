import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const D = '2026-10-05';

describe('transfer stok antar-outlet, HPP, dan margin', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let manager: string;
  let managerB: string;
  let supervisor: string;
  let ownerB: string;
  let term: string;

  const post = (path: string, tok: string | undefined, body?: unknown) => h.http('POST', path, tok, body ?? {});
  const get = (path: string, tok = owner) => h.http(path.startsWith('/v1') ? 'GET' : 'GET', path, tok);
  const stock = async (outlet: string) => Object.fromEntries(((await get(`/v1/outlets/${outlet}/stock`)).body as { ingredientId: string; expected: number | null; transferIn: number; transferOut: number }[]).map((r) => [r.ingredientId, r]));
  const hits = async () => ((await get('/v1/outlets/o2/incidents')).body as { hits: { rule: string; note: string }[] }[]).flatMap((i) => i.hits);

  beforeAll(async () => {
    h = await createHarness(WIB(`${D}T10:00:00`));
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'pusat', 'Dapur Pusat');
    await h.admin.createOutlet('t1', 'o2', 'Outlet 2', { terminals: ['term-2'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    managerB = await h.admin.createApiToken('t1', 'dewi', 'MANAGER');
    supervisor = await h.admin.createApiToken('t1', 'hendra', 'SUPERVISOR');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term = await h.admin.createDevice('t1', 'o2', 'term-2', 'terminal');
    for (const [id, name, unit] of [['kopi', 'Biji kopi', 'g'], ['susu', 'Susu segar', 'ml']]) expect((await post('/v1/ingredients', owner, { id, name, unit })).status).toBe(201);
    // stok awal: dapur pusat 20.000 g kopi dan 30.000 ml susu; outlet 2 punya 1.000 g kopi
    for (const [o, ing, qty] of [['pusat', 'kopi', 20_000], ['pusat', 'susu', 30_000], ['o2', 'kopi', 1_000], ['o2', 'susu', 2_000]] as const) {
      expect((await post(`/v1/outlets/${o}/stock/movements`, owner, { ingredientId: ing, kind: 'COUNT', qty })).status).toBe(201);
    }
    // harga pokok lewat penerimaan PO di dapur pusat: kopi Rp 0,12/g dan susu Rp 0,02/ml
    await post('/v1/suppliers', owner, { id: 'pemasok', name: 'Pemasok Utama' });
    await post('/v1/purchase-orders', owner, { outletId: 'pusat', supplierId: 'pemasok', lines: [{ ingredientId: 'kopi', qty: 5_000, unitCost: 0.12 }, { ingredientId: 'susu', qty: 5_000, unitCost: 0.02 }] });
    await post('/v1/purchase-orders/1/order', owner);
    await post('/v1/purchase-orders/1/receive', owner, { lines: [{ lineNo: 1, qty: 5_000 }, { lineNo: 2, qty: 5_000 }] });
  });
  afterAll(() => h.close());

  it('kirim: stok outlet asal turun seketika, stok tujuan belum berubah; validasi dan peran', async () => {
    const line = (ingredientId: string, qty: number) => ({ ingredientId, qty });
    const base = { fromOutletId: 'pusat', toOutletId: 'o2', lines: [line('kopi', 3_000), line('susu', 6_000)] };
    for (const [bad, why] of [
      [{ ...base, toOutletId: 'pusat' }, 'berbeda'], [{ ...base, lines: [] }, '1–50'], [{ ...base, lines: [line('kopi', 1), line('kopi', 2)] }, 'dua kali'],
      [{ ...base, lines: [line('kopi', 0)] }, 'jumlah'], [{ ...base, lines: [line('kopi', 25_001)] }, 'hanya'],
    ] as const) {
      const r = await post('/v1/stock-transfers', owner, bad);
      expect(r.status, why).toBe(400);
      expect(JSON.stringify(r.body)).toContain(why);
    }
    expect((await post('/v1/stock-transfers', owner, { ...base, toOutletId: 'tidak-ada' })).status).toBe(404);
    expect((await post('/v1/stock-transfers', owner, { ...base, lines: [line('tidak-ada', 1)] })).status).toBe(404);
    expect((await post('/v1/stock-transfers', supervisor, base)).status).toBe(403);
    expect((await post('/v1/stock-transfers', term, base)).status).toBe(403);
    const before = await stock('pusat');
    expect(before.kopi!.expected).toBe(25_000);
    const r = await post('/v1/stock-transfers', manager, base);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: 1 });
    const after = await stock('pusat');
    expect(after.kopi).toMatchObject({ expected: 22_000, transferOut: 3_000, transferIn: 0 });
    expect(after.susu).toMatchObject({ expected: 29_000 });
    expect((await stock('o2')).kopi).toMatchObject({ expected: 1_000, transferIn: 0 });
    const t = (await get('/v1/stock-transfers?outletId=o2')).body[0];
    expect(t).toMatchObject({ id: 1, status: 'SENT', fromOutlet: 'pusat', toOutlet: 'o2', sentBy: 'rina', stale: false });
    expect(t.lines.map((l: { ingredientId: string; qtySent: number; unitCost: number }) => [l.ingredientId, l.qtySent, l.unitCost])).toEqual([['kopi', 3_000, 0.12], ['susu', 6_000, 0.02]]);
  });

  it('terima: jumlah per baris wajib semua, tidak melebihi kiriman, pengirim tidak boleh menerima; kekurangan menandai transfer', async () => {
    const recv = (tok: string, lines: unknown) => post('/v1/stock-transfers/1/receive', tok, { lines });
    expect((await recv(manager, [{ ingredientId: 'kopi', qty: 3_000 }, { ingredientId: 'susu', qty: 6_000 }])).status).toBe(409); // pengirim sendiri
    expect((await recv(managerB, [{ ingredientId: 'kopi', qty: 3_000 }])).status).toBe(400); // baris tidak lengkap
    expect((await recv(managerB, [{ ingredientId: 'kopi', qty: 3_001 }, { ingredientId: 'susu', qty: 6_000 }])).status).toBe(400);
    expect((await recv(managerB, [{ ingredientId: 'kopi', qty: 3_000 }, { ingredientId: 'lain', qty: 1 }])).status).toBe(400);
    expect((await recv(supervisor, [])).status).toBe(403);
    const ok = await recv(managerB, [{ ingredientId: 'kopi', qty: 2_700 }, { ingredientId: 'susu', qty: 6_000 }]);
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ short: true, shortfallValue: Math.round(300 * 0.12) });
    expect((await stock('o2')).kopi).toMatchObject({ expected: 3_700, transferIn: 2_700 });
    expect((await stock('o2')).susu).toMatchObject({ expected: 8_000 });
    expect((await recv(managerB, [{ ingredientId: 'kopi', qty: 1 }, { ingredientId: 'susu', qty: 1 }])).status).toBe(409); // sudah diterima
    expect((await post('/v1/stock-transfers/1/cancel', manager, { reason: 'terlambat' })).status).toBe(409);
    const t = (await get('/v1/stock-transfers')).body.find((x: { id: number }) => x.id === 1);
    expect(t).toMatchObject({ status: 'RECEIVED', short: true, receivedBy: 'dewi' });
  });

  it('selisih penerimaan menjadi temuan R41 di outlet tujuan (dan asal)', async () => {
    h.setNow(WIB(`${D}T12:00:00`));
    await post('/v1/outlets/o2/evaluate', owner);
    const r41 = (await hits()).filter((x) => x.rule === 'R41');
    expect(r41).toHaveLength(1);
    expect(r41[0]!.note).toContain('kopi 3000→2700');
  });

  it('batalkan kiriman: stok asal kembali; hanya kiriman yang belum diterima; alasan wajib', async () => {
    const sent = await post('/v1/stock-transfers', ops, { fromOutletId: 'pusat', toOutletId: 'o2', lines: [{ ingredientId: 'susu', qty: 4_000 }] });
    expect(sent.body).toEqual({ id: 2 });
    expect((await stock('pusat')).susu!.expected).toBe(25_000);
    expect((await post('/v1/stock-transfers/2/cancel', ops, { reason: '' })).status).toBe(400);
    expect((await post('/v1/stock-transfers/2/cancel', ops, { reason: 'salah kirim' })).status).toBe(201);
    expect((await stock('pusat')).susu!.expected).toBe(29_000);
    expect((await post('/v1/stock-transfers/2/cancel', ops, { reason: 'salah kirim' })).status).toBe(409);
    expect((await post('/v1/stock-transfers/2/receive', managerB, { lines: [{ ingredientId: 'susu', qty: 4_000 }] })).status).toBe(409);
    expect((await post('/v1/stock-transfers/99/receive', managerB, { lines: [{ ingredientId: 'susu', qty: 1 }] })).status).toBe(404);
  });

  it('kiriman yang menggantung lebih dari 24 jam ditandai dan menjadi temuan R40', async () => {
    expect((await post('/v1/stock-transfers', ops, { fromOutletId: 'pusat', toOutletId: 'o2', lines: [{ ingredientId: 'kopi', qty: 1_000 }] })).body).toEqual({ id: 3 });
    h.setNow(WIB('2026-10-05T20:00:00'));
    expect((await get('/v1/stock-transfers?outletId=o2')).body.find((x: { id: number }) => x.id === 3).stale).toBe(false);
    h.setNow(WIB('2026-10-06T14:00:00'));
    expect((await get('/v1/stock-transfers?outletId=o2')).body.find((x: { id: number }) => x.id === 3).stale).toBe(true);
    await post('/v1/outlets/o2/evaluate', owner);
    expect((await hits()).filter((x) => x.rule === 'R40').map((x) => x.note)).toEqual([expect.stringContaining('transfer #3')]);
  });

  it('tenant lain tidak melihat atau menyentuh transfer; daftar tersaring per outlet', async () => {
    expect((await get('/v1/stock-transfers', ownerB)).body).toEqual([]);
    expect((await post('/v1/stock-transfers/3/receive', ownerB, { lines: [{ ingredientId: 'kopi', qty: 1_000 }] })).status).toBe(404);
    expect((await post('/v1/stock-transfers', ownerB, { fromOutletId: 'pusat', toOutletId: 'o2', lines: [{ ingredientId: 'kopi', qty: 1 }] })).status).toBe(404);
    expect((await get('/v1/stock-transfers?outletId=pusat')).body.map((x: { id: number }) => x.id)).toEqual([3, 2, 1]);
  });

  it('HPP dan margin per menu dari resep dasar dan harga pokok rata-rata; bahan tanpa harga ditandai', async () => {
    await post('/v1/menu', owner, { id: 'latte', name: 'Latte', price: 26_000, category: 'Kopi' });
    await post('/v1/menu', owner, { id: 'es-teh', name: 'Es Teh', price: 8_000, category: 'Minuman' });
    await post('/v1/menu', owner, { id: 'air', name: 'Air', price: 3_000, category: 'Minuman' });
    await post('/v1/ingredients', owner, { id: 'teh', name: 'Teh', unit: 'g' });
    await h.http('PUT', '/v1/menu/latte/recipe', owner, { lines: [{ ingredientId: 'kopi', qty: 18 }, { ingredientId: 'susu', qty: 200 }] });
    await h.http('PUT', '/v1/menu/es-teh/recipe', owner, { lines: [{ ingredientId: 'teh', qty: 5 }] });
    const costs = (await get('/v1/menu-cost')).body as { id: string; cost: number | null; margin: number | null; marginPct: number | null; missing: string[] }[];
    const by = Object.fromEntries(costs.map((c) => [c.id, c]));
    expect(by['latte']).toMatchObject({ cost: Math.round(18 * 0.12 + 200 * 0.02), missing: [] });
    expect(by['latte']!.margin).toBe(26_000 - by['latte']!.cost!);
    expect(by['latte']!.marginPct).toBe(Math.round(((26_000 - by['latte']!.cost!) / 26_000) * 1000) / 10);
    expect(by['es-teh']).toMatchObject({ cost: 0, missing: ['teh'] });
    expect(by['air']).toMatchObject({ cost: null, margin: null, marginPct: null });
    expect((await get('/v1/menu-cost', supervisor)).status).toBe(403);
    expect((await get('/v1/menu-cost', manager)).status).toBe(200);
  });

  it('jurnal HPP harian: pemakaian menurut resep × harga pokok, Dr Beban Bahan Baku Cr Persediaan', async () => {
    h.setNow(WIB('2026-10-06T21:00:00'));
    const s = new Sim('o2', D, 'term-2', 'sensor-2');
    const items = [{ itemId: 'latte', name: 'Latte', qty: 3, unitPrice: 26_000 }];
    s.pos({ type: 'order.created', payload: { orderId: 'a', orderType: 'TAKE_AWAY' } }, '15:00:00', 'budi');
    s.pos({ type: 'order.sent_to_kitchen', payload: { orderId: 'a', items } }, '15:01:00', 'budi');
    s.pos({ type: 'bill.printed', payload: { orderId: 'a', total: 78_000, items } }, '15:02:00', 'budi');
    s.pos({ type: 'payment.received', payload: { orderId: 'a', method: 'CASH', amount: 78_000 } }, '15:03:00', 'budi');
    expect((await h.postEvents(term, s.events)).status).toBe(201);
    const j = (await get('/v1/outlets/o2/accounting/journal?from=2026-10-05&to=2026-10-06')).body;
    const hpp = j.entries.find((e: { ref: string }) => e.ref === 'JU-HPP-o2-20261005');
    const biaya = Math.round(3 * (18 * 0.12 + 200 * 0.02));
    expect(hpp.lines).toEqual([{ account: '5-1000', debit: biaya, credit: 0 }, { account: '1-1400', debit: 0, credit: biaya }]);
    expect(hpp.notes[0]).toContain('harga pokok rata-rata saat ini');
    expect(j.entries.some((e: { ref: string }) => e.ref === 'JU-HPP-o2-20261006')).toBe(false); // hari tanpa pemakaian
    const rep = (await get('/v1/outlets/o2/accounting/reports?from=2026-10-05&to=2026-10-06')).body;
    expect(rep.trialBalance.totalDebit).toBe(rep.trialBalance.totalCredit);
    expect(rep.incomeStatement.expenses.find((x: { account: string }) => x.account === '5-1000').balance).toBe(biaya);
  });
});
