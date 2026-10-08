import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);

describe('pengadaan: supplier, pesanan pembelian, penerimaan, utang', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let manager: string;
  let supervisor: string;
  let ownerB: string;
  let term: string;

  const post = (path: string, tok: string | undefined, body?: unknown) => h.http('POST', path, tok, body ?? {});
  const get = (path: string, tok = owner) => h.http('GET', path, tok);
  const ingredients = async () => Object.fromEntries(((await get('/v1/ingredients')).body as { id: string; avgCost: number }[]).map((i) => [i.id, i.avgCost]));
  const movements = async () => (await h.db.admin.query<{ ingredient_id: string; kind: string; qty: number; outlet_id: string; note: string }>("select ingredient_id, kind, qty, outlet_id, note from stock_movement where kind = 'PURCHASE' order by id")).rows;

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-05T10:00:00'));
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1');
    await h.admin.createOutlet('t1', 'o2', 'Outlet 2');
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    supervisor = await h.admin.createApiToken('t1', 'hendra', 'SUPERVISOR');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'pos-1', 'terminal');
    for (const [id, name, unit] of [['kopi', 'Biji kopi', 'g'], ['susu', 'Susu segar', 'ml'], ['telur', 'Telur', 'pcs']]) {
      expect((await post('/v1/ingredients', owner, { id, name, unit, minStock: 100 })).status).toBe(201);
    }
  });
  afterAll(() => h.close());

  it('supplier: OWNER dan OPS mengelola, MANAGER membaca; id unik; nonaktif', async () => {
    expect((await post('/v1/suppliers', ops, { id: 'sumber-kopi', name: 'CV Sumber Kopi', phone: '0812 1111 2222' })).status).toBe(201);
    expect((await post('/v1/suppliers', owner, { id: 'sumber-kopi', name: 'Dobel' })).status).toBe(409);
    expect((await post('/v1/suppliers', owner, { id: 'Besar', name: 'X Y' })).status).toBe(400);
    expect((await post('/v1/suppliers', owner, { id: 'susu-segar', name: 'Peternakan Segar' })).status).toBe(201);
    expect((await post('/v1/suppliers', manager, { id: 'lain', name: 'Lain Lain' })).status).toBe(403);
    expect((await get('/v1/suppliers', manager)).body.map((s: { id: string }) => s.id)).toEqual(['sumber-kopi', 'susu-segar']);
    expect((await get('/v1/suppliers', supervisor)).status).toBe(403);
    expect((await get('/v1/suppliers', term)).status).toBe(403);
    expect((await h.http('PUT', '/v1/suppliers/susu-segar', owner, { phone: '0813 0000 1111' })).status).toBe(200);
    expect((await h.http('PUT', '/v1/suppliers/tidak-ada', owner, { name: 'X Y' })).status).toBe(404);
  });

  it('PO draf: validasi baris, supplier aktif, outlet ada; hanya draf yang bisa diubah', async () => {
    const line = (ingredientId: string, qty: number, unitCost: number) => ({ ingredientId, qty, unitCost });
    const base = { outletId: 'o1', supplierId: 'sumber-kopi', lines: [line('kopi', 10_000, 0.12), line('susu', 20_000, 0.015)] };
    for (const [bad, why] of [
      [{ ...base, lines: [] }, 'minimal satu'], [{ ...base, lines: [line('kopi', 1, 1), line('kopi', 2, 1)] }, 'dua kali'], [{ ...base, lines: [line('x-tidak-ada', 1, 1)] }, 'tidak ada'],
      [{ ...base, lines: [line('kopi', 0, 1)] }, 'jumlah'], [{ ...base, lines: [line('kopi', 1, -1)] }, 'harga satuan'], [{ ...base, expectedDate: 'besok' }, 'YYYY-MM-DD'],
    ] as const) {
      const r = await post('/v1/purchase-orders', owner, bad);
      expect(r.status, why).toBe(400);
      expect(JSON.stringify(r.body)).toContain(why);
    }
    expect((await post('/v1/purchase-orders', owner, { ...base, outletId: 'tidak-ada' })).status).toBe(404);
    expect((await post('/v1/purchase-orders', owner, { ...base, supplierId: 'tidak-ada' })).status).toBe(404);
    expect((await post('/v1/purchase-orders', manager, base)).status).toBe(403);
    const ok = await post('/v1/purchase-orders', ops, { ...base, expectedDate: '2026-10-08', note: 'Pesanan mingguan' });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ id: 1 });
    expect((await h.http('PUT', '/v1/purchase-orders/1', owner, { lines: [line('kopi', 12_000, 0.12), line('susu', 20_000, 0.015), line('telur', 60, 2_000)] })).status).toBe(200);
    const d = (await get('/v1/purchase-orders/1')).body;
    expect(d).toMatchObject({ status: 'DRAFT', outletId: 'o1', supplierId: 'sumber-kopi', note: 'Pesanan mingguan' });
    expect(d.lines.map((l: { ingredientId: string; qty: number; receivedQty: number }) => [l.ingredientId, l.qty, l.receivedQty])).toEqual([['kopi', 12_000, 0], ['susu', 20_000, 0], ['telur', 60, 0]]);
    expect((await post('/v1/purchase-orders/1/receive', owner, { lines: [{ lineNo: 1, qty: 1 }] })).status).toBe(409); // belum dipesan
    expect((await post('/v1/purchase-orders/1/order', owner)).status).toBe(201);
    expect((await post('/v1/purchase-orders/1/order', owner)).status).toBe(409);
    expect((await h.http('PUT', '/v1/purchase-orders/1', owner, { note: 'ubah' })).status).toBe(409);
  });

  it('penerimaan sebagian: stok bertambah, harga rata-rata terisi, utang bertambah; melebihi sisa ditolak; MANAGER boleh menerima', async () => {
    expect((await post('/v1/purchase-orders/1/receive', owner, { lines: [{ lineNo: 1, qty: 12_001 }] })).status).toBe(400);
    expect((await post('/v1/purchase-orders/1/receive', owner, { lines: [{ lineNo: 9, qty: 1 }] })).status).toBe(400);
    expect((await post('/v1/purchase-orders/1/receive', owner, { lines: [{ lineNo: 1, qty: 1 }, { lineNo: 1, qty: 1 }] })).status).toBe(400);
    expect((await post('/v1/purchase-orders/1/receive', owner, { lines: [] })).status).toBe(400);
    expect((await post('/v1/purchase-orders/1/receive', supervisor, { lines: [{ lineNo: 1, qty: 1 }] })).status).toBe(403);
    const r = await post('/v1/purchase-orders/1/receive', manager, { invoiceRef: 'INV-77', lines: [{ lineNo: 1, qty: 8_000 }, { lineNo: 2, qty: 20_000 }] });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ receiptId: 1, amount: 8_000 * 0.12 + 20_000 * 0.015, priceFlag: false, status: 'PARTIAL' }); // 960 + 300
    expect(await movements()).toEqual([
      { ingredient_id: 'kopi', kind: 'PURCHASE', qty: 8_000, outlet_id: 'o1', note: 'PO-1 INV-77' }, { ingredient_id: 'susu', kind: 'PURCHASE', qty: 20_000, outlet_id: 'o1', note: 'PO-1 INV-77' },
    ]);
    expect(await ingredients()).toMatchObject({ kopi: 0.12, susu: 0.015, telur: 0 });
    const d = (await get('/v1/purchase-orders/1')).body;
    expect(d.status).toBe('PARTIAL');
    expect(d.lines.map((l: { receivedQty: number }) => l.receivedQty)).toEqual([8_000, 20_000, 0]);
    expect(d.receipts).toEqual([expect.objectContaining({ id: 1, receivedBy: 'rina', invoiceRef: 'INV-77', amount: 1_260, priceFlag: false })]);
    expect((await post('/v1/purchase-orders/1/cancel', owner, { reason: 'batal saja' })).status).toBe(409); // sudah ada penerimaan
  });

  it('penerimaan susulan menutup PO; harga faktur lebih mahal >5% dari PO ditandai dan memengaruhi harga rata-rata', async () => {
    const r = await post('/v1/purchase-orders/1/receive', owner, { invoiceRef: 'INV-78', lines: [{ lineNo: 1, qty: 4_000, unitCost: 0.18 }, { lineNo: 3, qty: 60 }] });
    expect(r.body).toMatchObject({ amount: Math.round(4_000 * 0.18) + 60 * 2_000, priceFlag: true, status: 'RECEIVED' });
    const avg = await ingredients();
    // tanpa hitung fisik (stok tidak diketahui), harga rata-rata = harga pembelian terakhir
    expect(avg).toMatchObject({ kopi: 0.18, telur: 2_000 });
    expect((await post('/v1/purchase-orders/1/receive', owner, { lines: [{ lineNo: 1, qty: 1 }] })).status).toBe(409); // sudah selesai
    expect((await get('/v1/purchase-orders/1')).body.receipts.map((x: { priceFlag: boolean }) => x.priceFlag)).toEqual([false, true]);
  });

  it('harga rata-rata ditimbang dengan stok yang ada bila sudah pernah dihitung fisik', async () => {
    expect((await post('/v1/outlets/o2/stock/movements', owner, { ingredientId: 'susu', kind: 'COUNT', qty: 10_000 })).status).toBe(201);
    expect((await post('/v1/purchase-orders', owner, { outletId: 'o2', supplierId: 'susu-segar', lines: [{ ingredientId: 'susu', qty: 10_000, unitCost: 0.025 }] })).status).toBe(201);
    expect((await post('/v1/purchase-orders/2/order', owner)).status).toBe(201);
    expect((await post('/v1/purchase-orders/2/receive', owner, { lines: [{ lineNo: 1, qty: 10_000 }] })).status).toBe(201);
    // stok o2 10.000 ml (harga rata-rata tenant 0,015) + 10.000 ml @ 0,025 → 0,02
    expect((await ingredients()).susu).toBe(0.02);
  });

  it('utang supplier: tagihan dari penerimaan dikurangi pembayaran; tidak bisa membayar lebih dari utang; hanya OWNER membayar', async () => {
    const p = (await get('/v1/suppliers-payables', manager)).body as { supplierId: string; billed: number; paid: number; owed: number; flaggedReceipts: number }[];
    expect(p.find((x) => x.supplierId === 'sumber-kopi')).toMatchObject({ billed: 1_260 + 720 + 120_000, paid: 0, owed: 121_980, flaggedReceipts: 1 });
    expect(p.find((x) => x.supplierId === 'susu-segar')).toMatchObject({ billed: 250, owed: 250 });
    const pay = (tok: string, body: unknown) => post('/v1/suppliers/sumber-kopi/payments', tok, body);
    const base = { amount: 100_000, date: '2026-10-05', method: 'TRANSFER', ref: 'BCA-9911', outletId: 'o1' };
    expect((await pay(ops, base)).status).toBe(403);
    expect((await pay(owner, { ...base, amount: 0 })).status).toBe(400);
    expect((await pay(owner, { ...base, method: 'KARTU' })).status).toBe(400);
    expect((await pay(owner, { ...base, date: '2026-10-06' })).status).toBe(400); // masa depan
    expect((await pay(owner, { ...base, amount: 121_981 })).status).toBe(400); // melebihi utang
    expect((await pay(owner, { ...base, outletId: 'tidak-ada' })).status).toBe(404);
    expect((await post('/v1/suppliers/tidak-ada/payments', owner, base)).status).toBe(404);
    expect((await pay(owner, base)).status).toBe(201);
    expect((await get('/v1/suppliers-payables')).body.find((x: { supplierId: string }) => x.supplierId === 'sumber-kopi')).toMatchObject({ paid: 100_000, owed: 21_980, lastPaidDate: '2026-10-05' });
    expect((await pay(owner, { ...base, amount: 21_981 })).status).toBe(400);
  });

  it('pembatalan PO butuh alasan dan hanya sebelum ada penerimaan; PO outlet lain atau tenant lain tidak bocor', async () => {
    expect((await post('/v1/purchase-orders', owner, { outletId: 'o1', supplierId: 'susu-segar', lines: [{ ingredientId: 'telur', qty: 30, unitCost: 2_000 }] })).body).toEqual({ id: 3 });
    expect((await post('/v1/purchase-orders/3/cancel', owner, { reason: '' })).status).toBe(400);
    expect((await post('/v1/purchase-orders/3/cancel', manager, { reason: 'tidak jadi' })).status).toBe(403);
    expect((await post('/v1/purchase-orders/3/cancel', owner, { reason: 'tidak jadi' })).status).toBe(201);
    expect((await post('/v1/purchase-orders/3/order', owner)).status).toBe(409);
    expect((await get('/v1/purchase-orders?status=CANCELED')).body.map((x: { id: number }) => x.id)).toEqual([3]);
    expect((await get('/v1/purchase-orders?outletId=o2')).body.map((x: { id: number }) => x.id)).toEqual([2]);
    expect((await get('/v1/purchase-orders', ownerB)).body).toEqual([]);
    expect((await get('/v1/purchase-orders/1', ownerB)).status).toBe(404);
    expect((await post('/v1/purchase-orders/1/receive', ownerB, { lines: [{ lineNo: 1, qty: 1 }] })).status).toBe(404);
    expect((await get('/v1/purchase-orders/99')).status).toBe(404);
  });

  it('jurnal akuntansi: penerimaan = Dr Persediaan Cr Utang; pembayaran transfer = Dr Utang Cr Bank; seimbang', async () => {
    const j = (await get('/v1/outlets/o1/accounting/journal?from=2026-10-05&to=2026-10-05')).body;
    const buy = j.entries.filter((e: { ref: string }) => e.ref.startsWith('JU-BELI'));
    expect(buy.map((e: { ref: string }) => e.ref)).toEqual(['JU-BELI-1', 'JU-BELI-2']);
    expect(buy[0].lines).toEqual([{ account: '1-1400', debit: 1_260, credit: 0 }, { account: '2-1100', debit: 0, credit: 1_260 }]);
    expect(buy[0].memo).toBe('Pembelian dari CV Sumber Kopi (faktur INV-77)');
    const bayar = j.entries.find((e: { ref: string }) => e.ref === 'JU-BAYAR-1');
    expect(bayar.lines).toEqual([{ account: '2-1100', debit: 100_000, credit: 0 }, { account: '1-1300', debit: 0, credit: 100_000 }]);
    const rep = (await get('/v1/outlets/o1/accounting/reports?from=2026-10-05&to=2026-10-05')).body.trialBalance;
    expect(rep.totalDebit).toBe(rep.totalCredit);
    expect(rep.rows.find((r: { account: string }) => r.account === '2-1100')).toMatchObject({ balance: 1_260 + 120_720 - 100_000 });
  });
});
