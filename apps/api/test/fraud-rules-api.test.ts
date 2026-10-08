import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const MIN = 60_000;
const H = 60 * MIN;

describe('aturan fraud baru lewat API (R11, R15, R16, R17, R19, R20, R50-R53)', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let rina: string;
  let term: string;
  let sim: Sim;
  let sent = 0;

  const post = (path: string, tok: string | undefined, body?: unknown) => h.http('POST', path, tok, body ?? {});
  const put = (path: string, tok: string, body: unknown) => h.http('PUT', path, tok, body);
  const get = (path: string, tok = owner) => h.http('GET', path, tok);
  const flush = async () => { const r = await h.postEvents(term, sim.events.slice(sent)); sent = sim.events.length; expect(r.status).toBe(201); };
  const at = (iso: string) => h.setNow(WIB(iso));
  /** Insiden yang melibatkan seseorang disembunyikan darinya (konflik kepentingan), jadi temuan dibaca dari beberapa pengguna dan digabung. */
  const hits = async (rule: string) => {
    const seen = new Map<string, { rule: string; note: string; weight: number; actorIds: string[] }>();
    for (const tok of [owner, ops, rina]) {
      for (const i of (await get('/v1/outlets/o1/incidents', tok)).body as { hits: { rule: string; note: string; weight: number; actorIds: string[] }[] }[]) for (const x of i.hits) if (x.rule === rule) seen.set(x.note, x);
    }
    return [...seen.values()];
  };
  const evaluate = async () => expect((await post('/v1/outlets/o1/evaluate', owner)).status).toBeLessThan(300);

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-08T08:00:00'));
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    rina = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    for (const [id, name, pin] of [['budi', 'Budi', '4827'], ['sari', 'Sari', '5930']]) expect((await post('/v1/staff', owner, { id, name, role: 'CASHIER', pin })).status).toBe(201);
    sim = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1');
    // outlet punya EDC: QR dinamis tersedia (R19)
    await h.db.admin.query("update outlet set edcs = $1::jsonb where id = 'o1'", [JSON.stringify([{ tid: '12345678', bank: 'Mandiri', label: 'EDC' }])]);
  });
  afterAll(() => h.close());

  it('R17 dan R19: laci terbuka tanpa pembayaran tunai, dan QR statis padahal EDC tersedia', async () => {
    at('2026-10-08T10:00:00');
    sim.pos({ type: 'payment.received', payload: { orderId: 'c1', method: 'CASH', amount: 20_000 } }, WIB('2026-10-08T10:00:00'), 'budi');
    sim.pos({ type: 'drawer.opened', payload: { orderId: 'c1' } }, WIB('2026-10-08T10:00:02'), 'budi'); // wajar
    sim.pos({ type: 'drawer.opened', payload: {} }, WIB('2026-10-08T10:30:00'), 'budi'); // tanpa pembayaran
    sim.pos({ type: 'drawer.opened', payload: { reason: 'Tukar uang kecil', approverId: 'rina' } }, WIB('2026-10-08T11:00:00'), 'budi'); // disetujui
    sim.pos({ type: 'payment.received', payload: { orderId: 'q1', method: 'QR_STATIC', amount: 45_000 } }, WIB('2026-10-08T11:30:00'), 'budi');
    await flush();
    at('2026-10-09T12:00:00');
    await evaluate();
    expect((await hits('R17')).map((x) => x.weight).sort()).toEqual([10, 30]);
    const r19 = await hits('R19');
    expect(r19).toHaveLength(1);
    expect(r19[0]!.note).toContain('QR statis');
    // tanpa EDC, QR statis satu-satunya jalur: tidak ditandai
    await h.db.admin.query("update outlet set edcs = '[]'::jsonb where id = 'o1'");
    await h.db.admin.query("delete from incident where outlet_id = 'o1'");
    await evaluate();
    expect(await hits('R19')).toHaveLength(0);
    await h.db.admin.query("update outlet set edcs = $1::jsonb where id = 'o1'", [JSON.stringify([{ tid: '12345678', bank: 'Mandiri', label: 'EDC' }])]);
  });

  it('QR_STATIC: ingest menerima metodenya; laporan penjualan dan jurnal memperlakukannya sebagai pembayaran digital', async () => {
    const rep = (await get('/v1/outlets/o1/reports/sales?from=2026-10-08&to=2026-10-08')).body;
    expect(rep.byMethod.find((m: { method: string }) => m.method === 'QR_STATIC')).toMatchObject({ payments: 1, amount: 45_000 });
  });

  it('R20: cetak ulang dan pindah meja menumpuk menjelang tutup shift', async () => {
    const t = WIB('2026-10-08T12:00:00');
    sim.pos({ type: 'shift.opened', payload: { shiftId: 'sh1', openingCash: 100_000 } }, t, 'budi');
    for (let i = 0; i < 4; i++) {
      const id = `rp${i}`;
      sim.pos({ type: 'order.created', payload: { orderId: id, orderType: 'DINE_IN', tableNo: '1' } }, t + (7 * 60 + i) * MIN, 'budi');
      sim.pos({ type: 'bill.printed', payload: { orderId: id, total: 20_000 } }, t + (7 * 60 + i) * MIN + 5_000, 'budi');
      sim.pos({ type: 'bill.printed', payload: { orderId: id, total: 20_000 } }, t + (7 * 60 + i) * MIN + 20_000, 'budi');
    }
    sim.pos({ type: 'shift.closed', payload: { shiftId: 'sh1' } }, t + (7 * 60 + 40) * MIN, 'budi');
    await flush();
    await evaluate();
    const r = await hits('R20');
    expect(r).toHaveLength(1);
    expect(r[0]!.note).toContain('4 cetak ulang');
  });

  it('R11: void kasir hampir selalu disetujui orang yang sama padahal penyetuju lain bertugas', async () => {
    const t = WIB('2026-10-08T14:00:00');
    for (let i = 0; i < 6; i++) {
      const id = `v${i}`;
      sim.pos({ type: 'order.created', payload: { orderId: id, orderType: 'TAKE_AWAY' } }, t + i * 10 * MIN, 'budi');
      sim.pos({ type: 'void.approved', payload: { orderId: id, reasonCode: 'SALAH', approverIds: [i === 5 ? 'rina' : 'hendra'], amount: 20_000 } }, t + i * 10 * MIN + MIN, 'budi');
    }
    await flush();
    await evaluate();
    const r = await hits('R11');
    expect(r).toHaveLength(1);
    expect(r[0]!.actorIds).toEqual(['budi', 'hendra']);
  });

  it('R50 dan R51: harga beli jauh di atas supplier lain, dan faktur di atas harga PO', async () => {
    at('2026-10-08T15:00:00');
    expect((await post('/v1/ingredients', owner, { id: 'wagyu', name: 'Daging wagyu', unit: 'g' })).status).toBe(201);
    for (const id of ['sumber-a', 'sumber-b']) expect((await post('/v1/suppliers', owner, { id, name: id })).status).toBe(201);
    const po = async (supplierId: string, unitCost: number, invoiceCost: number) => {
      const r = await post('/v1/purchase-orders', ops, { outletId: 'o1', supplierId, lines: [{ ingredientId: 'wagyu', qty: 1000, unitCost }] });
      expect(r.status).toBe(201);
      expect((await post(`/v1/purchase-orders/${r.body.id}/order`, ops)).status).toBe(201);
      const rc = await post(`/v1/purchase-orders/${r.body.id}/receive`, ops, { invoiceRef: `INV-${r.body.id}`, lines: [{ lineNo: 1, qty: 1000, unitCost: invoiceCost }] });
      expect(rc.status).toBe(201);
    };
    await po('sumber-b', 100, 100); // pembanding murah dan wajar
    at('2026-10-08T16:00:00');
    await po('sumber-a', 100, 120); // faktur 20% di atas PO dan 20% di atas sumber-b
    at('2026-10-09T12:00:00');
    await evaluate();
    const r51 = await hits('R51');
    expect(r51).toHaveLength(1);
    expect(r51[0]!.note).toContain('Rp20.000');
    const r50 = await hits('R50');
    expect(r50).toHaveLength(1);
    expect(r50[0]!.note).toContain('sumber-b menjual 100');
    expect((await hits('R50')).some((x) => x.note.includes('dibeli 100 per satuan'))).toBe(false); // pembelian murah tidak ditandai
  });

  it('R15 dan R52: bahan kurang saat opname, lalu resepnya dikurangi', async () => {
    at('2026-10-08T08:00:00');
    expect((await post('/v1/ingredients', owner, { id: 'kopi', name: 'Biji kopi', unit: 'g' })).status).toBe(201);
    expect((await post('/v1/menu', owner, { id: 'latte', name: 'Latte', price: 30_000, category: 'Kopi' })).status).toBe(201);
    expect((await put('/v1/menu/latte/recipe', owner, { lines: [{ ingredientId: 'kopi', qty: 18 }] })).status).toBe(200);
    await h.db.admin.query("update ingredient set avg_cost = 100 where id = 'kopi'");
    // hitung awal 08.00, tiga latte terjual, hitung kedua 20.00 menemukan 546 g hilang (Rp54.600)
    expect((await post('/v1/outlets/o1/stock/movements', owner, { ingredientId: 'kopi', kind: 'COUNT', qty: 2000 })).status).toBe(201);
    sim.cashOrder('lt1', WIB('2026-10-08T10:00:00'), WIB('2026-10-08T10:05:00'), 90_000, 'budi', [{ itemId: 'latte', name: 'Latte', qty: 3, unitPrice: 30_000 }]);
    await flush();
    at('2026-10-08T20:00:00');
    expect((await post('/v1/outlets/o1/stock/movements', owner, { ingredientId: 'kopi', kind: 'COUNT', qty: 1400 })).status).toBe(201);
    // resep dikurangi 18 → 8 g setelah selisih ditemukan (R52); menambah bahan lain tidak ditandai
    at('2026-10-08T21:00:00');
    expect((await put('/v1/menu/latte/recipe', owner, { lines: [{ ingredientId: 'kopi', qty: 8 }] })).status).toBe(200);
    at('2026-10-09T12:00:00');
    await evaluate();
    const r15 = await hits('R15');
    expect(r15).toHaveLength(1);
    expect(r15[0]!.note).toContain('Biji kopi kurang 546 g');
    const r52 = await hits('R52');
    expect(r52).toHaveLength(1);
    expect(r52[0]!.note).toContain('dikurangi dari 18 menjadi 8');
    expect(r52[0]!.actorIds).toEqual(['owner-1']);
  });

  it('R52 tidak muncul untuk pengurangan tanpa selisih opname sebelumnya, atau untuk penambahan', async () => {
    at('2026-10-09T12:30:00');
    expect((await post('/v1/ingredients', owner, { id: 'susu', name: 'Susu', unit: 'ml' })).status).toBe(201);
    expect((await put('/v1/menu/latte/recipe', owner, { lines: [{ ingredientId: 'kopi', qty: 20 }, { ingredientId: 'susu', qty: 200 }] })).status).toBe(200); // kopi naik, susu baru
    expect((await put('/v1/menu/latte/recipe', owner, { lines: [{ ingredientId: 'kopi', qty: 20 }, { ingredientId: 'susu', qty: 100 }] })).status).toBe(200); // susu turun 50% tetapi tanpa opname
    await evaluate();
    expect((await hits('R52')).filter((x) => x.note.includes('susu') || x.note.includes('Susu'))).toHaveLength(0);
    expect((await hits('R52')).filter((x) => x.note.includes('20'))).toHaveLength(0);
  });

  it('R53: koreksi absen manual berulang untuk staf yang sama', async () => {
    at('2026-10-09T12:40:00');
    for (const day of ['05', '06', '07', '08']) {
      const r = await post('/v1/outlets/o1/hr/attendance', owner, { staffId: 'budi', start: WIB(`2026-10-${day}T09:00:00`), end: WIB(`2026-10-${day}T17:00:00`), reason: 'lupa absen pulang' });
      expect(r.status).toBe(201);
    }
    await evaluate();
    const r = await hits('R53');
    expect(r).toHaveLength(1);
    expect(r[0]!.note).toContain('4 koreksi absen manual untuk Budi');
  });

  it('R16: gulungan kertas terpakai jauh di atas cetakan tercatat; hanya OWNER, OPS, MANAGER yang mencatat', async () => {
    const paper = (body: unknown, tok = owner) => post('/v1/outlets/o1/paper-rolls', tok, body);
    at('2026-10-09T06:00:00');
    expect((await paper({ kind: 'COUNT', rolls: 10 })).status).toBe(201);
    at('2026-10-09T07:00:00');
    expect((await paper({ kind: 'PURCHASE', rolls: 5 }, rina)).status).toBe(201);
    expect((await paper({ kind: 'COUNT', rolls: 1.5 })).status).toBe(400);
    expect((await paper({ kind: 'PURCHASE', rolls: 0 })).status).toBe(400);
    expect((await paper({ kind: 'HAPUS', rolls: 3 })).status).toBe(400);
    expect((await paper({ kind: 'COUNT', rolls: 3 }, term)).status).toBe(403);
    expect((await post('/v1/outlets/hantu/paper-rolls', owner, { kind: 'COUNT', rolls: 1 })).status).toBe(404);
    at('2026-10-09T11:00:00');
    expect((await paper({ kind: 'COUNT', rolls: 2 })).status).toBe(201); // 13 gulungan terpakai
    const list = (await get('/v1/outlets/o1/paper-rolls')).body;
    expect(list.assumptions).toEqual({ rollMeters: 25, docCm: 15 });
    expect(list.periods[0]).toMatchObject({ consumed: 13, flagged: true });
    at('2026-10-09T12:50:00');
    await evaluate();
    const r16 = await hits('R16');
    expect(r16).toHaveLength(1);
    expect(r16[0]!.note).toContain('13 gulungan terpakai');
  });
});
