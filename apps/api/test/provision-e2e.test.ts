import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigClient, MemoryStore, PosEngine, Recorder, SimPrinter, SyncClient, toPosConfig } from '@pos/pos-core';
import { createHarness, type Harness } from './harness';

/**
 * Terminal baru dikonfigurasi seluruhnya dari server: owner membuat staf, menu, dan pengaturan lewat API,
 * terminal mengunduh konfigurasi lalu kasir masuk dengan PIN yang dibuat owner. Tidak ada data demo di perangkat.
 */
describe('provisioning terminal dari server', () => {
  let h: Harness;
  let owner: string;
  let term: string;
  let now = Date.parse('2026-10-02T10:00:00+07:00');
  let configClient: ConfigClient;
  let engine: PosEngine;
  let sync: SyncClient;
  let baseUrl: string;

  const put = (p: string, b: unknown) => h.http('PUT', p, owner, b);
  const post = (p: string, b: unknown) => h.http('POST', p, owner, b);

  beforeAll(async () => {
    h = await createHarness(now);
    await h.admin.createTenant('tc', 'Toko C');
    await h.admin.createOutlet('tc', 'oc', 'Toko C Pusat', { terminals: ['pos-c'] });
    term = await h.admin.createDevice('tc', 'oc', 'pos-c', 'terminal');
    owner = await h.admin.createApiToken('tc', 'owner-c', 'OWNER');
    baseUrl = `http://127.0.0.1:${(h.app.getHttpServer().address() as { port: number }).port}`;

    await put('/v1/outlets/oc/settings', { merchantName: 'Toko C', taxPercent: 11, edcs: [{ tid: '55501234', bank: 'BCA', label: 'EDC BCA' }] });
    await post('/v1/staff', { id: 'rudi', name: 'Rudi', role: 'CASHIER', pin: '4827' });
    await post('/v1/staff', { id: 'spv', name: 'Supervisor C', role: 'SUPERVISOR', pin: '7351' });
    await post('/v1/menu', { id: 'kopi', name: 'Kopi', price: 20_000, category: 'Minuman' });

    const store = new MemoryStore();
    configClient = new ConfigClient(store, { baseUrl, token: term, now: () => now });
    const r = await configClient.refresh();
    if (r.status !== 'updated') throw new Error(`konfigurasi gagal: ${JSON.stringify(r)}`);
    const config = toPosConfig(r.config);
    const recorder = new Recorder({ deviceId: config.deviceId, outletId: config.outletId, store, now: () => now });
    engine = new PosEngine({ config, recorder, store, printer: new SimPrinter(), now: () => now });
    await engine.init();
    sync = new SyncClient(recorder, { baseUrl, token: term, now: () => now });
  });
  afterAll(() => h.close());

  it('kasir masuk dengan PIN dari owner; PIN salah dan staf yang tidak dikenal ditolak', async () => {
    expect(engine.config).toMatchObject({ deviceId: 'pos-c', outletId: 'oc', merchantName: 'Toko C', taxPercent: 11 });
    expect(engine.staff().map((s) => s.id).sort()).toEqual(['rudi', 'spv']);
    expect(await engine.login('rudi', '0000')).toMatchObject({ ok: false, code: 'PIN_WRONG' });
    expect(await engine.login('hantu', '4827')).toMatchObject({ ok: false, code: 'PIN_WRONG' });
    expect((await engine.login('rudi', '4827')).ok).toBe(true);
  });

  it('transaksi memakai menu, pajak, dan EDC dari server, dan eventnya diterima server', async () => {
    const must = <T>(r: { ok: boolean; value?: T; code?: string; message?: string }) => {
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      return r.value as T;
    };
    must(await engine.openShift(50_000));
    const o = must<{ id: string }>(await engine.createOrder('TAKE_AWAY'));
    must(await engine.addItem(o.id, 'kopi', 1));
    must(await engine.printBill(o.id));
    const order = engine.getOrder(o.id)!;
    expect(engine.totals(order).total).toBe(22_200); // 20.000 + PBJT 11%

    // QRIS memakai satu-satunya EDC terdaftar dari server
    must(await engine.pay(o.id, { method: 'QRIS' }));
    await sync.flush();
    const pay = await h.db.tenantTx('tc', async (q) =>
      (await q.query<{ payload: { tid: string; amount: number } }>("select payload from event where type = 'payment.received'")).rows,
    );
    expect(pay[0]!.payload).toMatchObject({ tid: '55501234', amount: 22_200 });
  });

  it('perubahan owner berlaku di terminal setelah sinkronisasi: harga baru, staf dinonaktifkan', async () => {
    await put('/v1/menu/kopi', { price: 25_000 });
    await put('/v1/staff/rudi', { active: false });

    const r = await configClient.refresh();
    expect(r.status).toBe('updated');
    if (r.status !== 'updated') return;
    engine.setConfig(toPosConfig(r.config));

    expect(engine.config.menu.find((m) => m.id === 'kopi')!.price).toBe(25_000);
    expect(engine.staff().map((s) => s.id)).toEqual(['spv']);
    expect(await engine.login('rudi', '4827')).toMatchObject({ ok: false, code: 'PIN_WRONG' });
    expect(await engine.login('spv', '7351')).toMatchObject({ ok: true });
  });

  it('identitas perangkat tidak bisa diganti di tengah jalan', async () => {
    const cfg = { ...engine.config, deviceId: 'pos-lain' };
    expect(() => engine.setConfig(cfg)).toThrow(/identitas perangkat/);
  });
});
