import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoConfig, MemoryStore, PosEngine, Recorder, SimPrinter, SyncClient } from '@pos/pos-core';
import { createHarness, type Harness } from './harness';

const WIB = (hms: string) => Date.parse(`2026-10-01T${hms}+07:00`);

/**
 * Pisah bill, gabung order, pindah meja, dan pembayaran sebagian dari POS sungguhan (PosEngine + SyncClient) ke API sungguhan:
 * event asli dari engine harus diterima ingest tanpa masalah integritas, dan laporan owner harus cocok dengan hitungan manual.
 */
describe('POS → API: pisah bill, gabung, pindah meja', () => {
  let h: Harness;
  let now: number;
  let engine: PosEngine;
  let recorder: Recorder;
  let owner: string;

  const must = <T>(r: { ok: boolean; value?: T; code?: string; message?: string }): T => {
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    return r.value as T;
  };

  beforeAll(async () => {
    now = WIB('10:00:00');
    h = await createHarness(now);
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createOutlet('t1', 'o1', 'Kopi Senopati', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    const token = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    const config = await demoConfig('o1', 'term-1');
    const store = new MemoryStore();
    recorder = new Recorder({ deviceId: 'term-1', outletId: 'o1', store, now: () => now });
    engine = new PosEngine({ config, recorder, store, printer: new SimPrinter(), now: () => now });
    await engine.init();
    await engine.login('budi', config.demoPins.budi);
    must(await engine.openShift(100_000));

    const sync = new SyncClient(recorder, { baseUrl: `http://127.0.0.1:${(h.app.getHttpServer().address() as { port: number }).port}`, token, now: () => now });

    // Meja 5: 3 kopi + 1 matcha Large (dikirim ke dapur), lalu 1 kopi dan matcha dipisah, pindah meja, bayar terpisah.
    const a = must(await engine.createOrder('DINE_IN', { tableNo: '5' })).id;
    must(await engine.addItem(a, 'kopi-susu', 3));
    must(await engine.addItem(a, 'matcha', 1, { options: ['large'], note: 'es sedikit' }));
    must(await engine.sendToKitchen(a));
    now += 60_000;
    const b = must(await engine.splitOrder(a, [{ lineId: 'kopi-susu', qty: 1 }, { lineId: 'matcha', qty: 1 }])).id;
    must(await engine.moveTable(b, '9'));
    must(await engine.printBill(b));
    must(await engine.pay(b, { method: 'QRIS', tid: '12345678' }));
    must(await engine.printBill(a));
    must(await engine.pay(a, { method: 'CASH', amount: 30_000, tendered: 30_000 })); // sebagian
    must(await engine.pay(a, { method: 'QRIS', tid: '12345678' }));                  // sisanya

    // Dua take-away digabung: 1 latte + 2 latte → satu bill 3 latte.
    const c = must(await engine.createOrder('TAKE_AWAY')).id;
    const d = must(await engine.createOrder('TAKE_AWAY')).id;
    must(await engine.addItem(c, 'latte', 1));
    must(await engine.addItem(d, 'latte', 2));
    must(await engine.mergeOrders(c, d));
    must(await engine.printBill(c));
    must(await engine.pay(c, { method: 'CASH' }));

    now += 60_000;
    const r = await sync.flush();
    expect(r).toMatchObject({ ok: true, remaining: 0, issues: [] });
  });
  afterAll(() => h.close());

  it('semua event diterima: rantai utuh tanpa celah, tidak ada yang tertinggal di antrean', async () => {
    const rows = await h.db.tenantTx('t1', async (q) =>
      (await q.query<{ seq: number; type: string; integrity: string | null }>("select seq, type, integrity from event where device_id = 'term-1' order by seq")).rows,
    );
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
    expect(rows.every((r) => r.integrity === null)).toBe(true);
    expect(rows.filter((r) => r.type === 'order.items_moved')).toHaveLength(2);
    expect(rows.filter((r) => r.type === 'order.table_changed')).toHaveLength(1);
    expect(await recorder.pendingCount()).toBe(0);
  });

  it('laporan owner: tiga bill terbayar, produk dan opsi sesuai hitungan manual', async () => {
    const r = await h.http('GET', '/v1/outlets/o1/reports/sales?from=2026-10-01&to=2026-10-01', owner);
    expect(r.status).toBe(200);
    // bill b: kopi 22.000 + matcha Large 34.000 = 56.000 → +10% = 61.600
    // bill a: 2 kopi = 44.000 → 48.400 (tunai 30.000 + QRIS 18.400)
    // bill c: 3 latte = 78.000 → 85.800
    expect(r.body.totals).toMatchObject({ gross: 61_600 + 48_400 + 85_800, orders: 3 });
    expect(r.body.byProduct).toEqual([
      { itemId: 'latte', name: 'Latte', qty: 3, amount: 78_000 },
      { itemId: 'kopi-susu', name: 'Kopi Susu', qty: 3, amount: 66_000 },
      { itemId: 'matcha', name: 'Matcha Latte', qty: 1, amount: 34_000 },
    ]);
    expect(r.body.byOption).toEqual([{ group: 'Ukuran', name: 'Large', qty: 1, amount: 6_000 }]);
    expect(r.body.byMethod.filter((m: { payments: number }) => m.payments > 0)).toEqual([
      { method: 'CASH', payments: 2, amount: 30_000 + 85_800 },
      { method: 'QRIS', payments: 2, amount: 61_600 + 18_400 },
    ]);
    expect(r.body.ordersWithoutItems).toBe(0);
  });
});
