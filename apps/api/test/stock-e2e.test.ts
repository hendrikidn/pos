import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoConfig, MemoryStore, PosEngine, Recorder, SimPrinter, SyncClient } from '@pos/pos-core';
import { createHarness, type Harness } from './harness';

const WIB = (hms: string) => Date.parse(`2026-10-01T${hms}+07:00`);

/** Penjualan dari terminal POS sungguhan (PosEngine) mengurangi stok sesuai resep dasar dan resep opsi. */
describe('POS → stok', () => {
  let h: Harness;
  let now: number;
  let engine: PosEngine;
  let sync: SyncClient;
  let owner: string;
  let pins: Awaited<ReturnType<typeof demoConfig>>['demoPins'];
  const must = <T>(r: { ok: boolean; value?: T; code?: string; message?: string }): T => {
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    return r.value as T;
  };
  const at = (hms: string) => { now = WIB(hms); h.setNow(now); };
  const stock = async () => Object.fromEntries(((await h.http('GET', '/v1/outlets/o1/stock', owner)).body as { ingredientId: string; expected: number; used: number }[]).map((r) => [r.ingredientId, r]));

  beforeAll(async () => {
    now = WIB('08:00:00');
    h = await createHarness(now);
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createOutlet('t1', 'o1', 'Kopi Senopati', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    const token = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    const port = (h.app.getHttpServer().address() as { port: number }).port;

    // Menu di server sama dengan menu demo POS (id grup dan opsi harus sama: dari sinilah id opsi di event berasal).
    const cfg = await demoConfig('o1', 'term-1');
    pins = cfg.demoPins;
    for (const m of cfg.menu.filter((x) => x.id === 'matcha' || x.id === 'kopi-susu')) {
      expect((await h.http('POST', '/v1/menu', owner, { id: m.id, name: m.name, price: m.price, category: m.category, ...(m.modifierGroups ? { modifierGroups: m.modifierGroups } : {}) })).status).toBe(201);
    }
    for (const [id, unit] of [['bubuk', 'g'], ['susu', 'ml'], ['oat', 'ml']] as const) await h.http('POST', '/v1/ingredients', owner, { id, name: id, unit });
    const R = (menu: string, body: object) => h.http('PUT', `/v1/menu/${menu}/recipe`, owner, body);
    expect((await R('matcha', { lines: [{ ingredientId: 'bubuk', qty: 5 }] })).status).toBe(200);
    expect((await R('matcha', { optionId: 'oat', lines: [{ ingredientId: 'oat', qty: 200 }] })).status).toBe(200);
    expect((await R('matcha', { optionId: 'large', lines: [{ ingredientId: 'susu', qty: 50 }] })).status).toBe(200);
    expect((await R('kopi-susu', { lines: [{ ingredientId: 'susu', qty: 150 }] })).status).toBe(200);
    for (const [ingredientId, qty] of [['bubuk', 1000], ['susu', 10_000], ['oat', 5_000]] as const) {
      expect((await h.http('POST', '/v1/outlets/o1/stock/movements', owner, { ingredientId, kind: 'COUNT', qty })).status).toBe(201);
    }

    const store = new MemoryStore();
    const rec = new Recorder({ deviceId: 'term-1', outletId: 'o1', store, now: () => now });
    engine = new PosEngine({ config: cfg, recorder: rec, store, printer: new SimPrinter(), now: () => now });
    await engine.init();
    sync = new SyncClient(rec, { baseUrl: `http://127.0.0.1:${port}`, token, now: () => now });
    await engine.login('budi', pins.budi);
    must(await engine.openShift(100_000));
  });
  afterAll(() => h.close());

  it('matcha Large + Oat ×2 dan kopi susu ×1: bubuk 10 g, oat 400 ml, susu 2×50 + 150 = 250 ml', async () => {
    at('10:00:00');
    const a = must<{ id: string }>(await engine.createOrder('TAKE_AWAY')).id;
    must(await engine.addItem(a, 'matcha', 2, { options: ['large', 'oat'] }));
    must(await engine.addItem(a, 'kopi-susu', 1));
    must(await engine.sendToKitchen(a));
    must(await engine.printBill(a));
    must(await engine.pay(a, { method: 'CASH' }));
    expect(await sync.flush()).toMatchObject({ ok: true, remaining: 0, issues: [] });
    at('11:00:00');
    const s = await stock();
    expect(s['bubuk']).toMatchObject({ used: 10, expected: 990 });
    expect(s['oat']).toMatchObject({ used: 400, expected: 4600 });
    expect(s['susu']).toMatchObject({ used: 250, expected: 9750 });
  });

  it('order yang di-void sebelum dikirim ke dapur tidak memakai stok; yang di-void sesudah dikirim memakai', async () => {
    at('11:10:00');
    const b = must<{ id: string }>(await engine.createOrder('TAKE_AWAY')).id;
    must(await engine.addItem(b, 'kopi-susu', 3));
    must(await engine.voidOrder(b, 'WRONG_ORDER', [])); // draf: tanpa persetujuan, belum dikirim
    const c = must<{ id: string }>(await engine.createOrder('TAKE_AWAY')).id;
    must(await engine.addItem(c, 'kopi-susu', 2));
    must(await engine.sendToKitchen(c));
    must(await engine.voidOrder(c, 'WRONG_ORDER', [{ userId: 'hendra', pin: pins.hendra }]));
    await sync.flush();
    at('12:00:00');
    expect((await stock())['susu']).toMatchObject({ used: 250 + 300 });
  });
});
