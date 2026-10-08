import { describe, expect, it } from 'vitest';
import { demoConfig, MemoryStore, PosEngine, Recorder, SimPrinter, type WebOrderInput } from '../src';

const T0 = Date.parse('2026-10-01T12:00:00+07:00');

async function setup(openShift = true) {
  const store = new MemoryStore();
  const config = await demoConfig();
  const recorder = new Recorder({ deviceId: config.deviceId, outletId: config.outletId, store, now: () => T0 });
  const engine = new PosEngine({ config, recorder, store, printer: new SimPrinter(), now: () => T0 });
  await engine.init();
  expect((await engine.login('budi', config.demoPins.budi)).ok).toBe(true);
  if (openShift) expect((await engine.openShift(0)).ok).toBe(true);
  return { engine, recorder };
}
const web = (over: Partial<WebOrderInput> = {}): WebOrderInput => ({
  id: 41, code: 'W41', name: 'Dewi', type: 'TAKE_AWAY',
  items: [{ itemId: 'kopi-susu', name: 'Kopi Susu', qty: 2, options: [] }, { itemId: 'matcha', name: 'Matcha Latte', qty: 1, options: ['large', 'boba'], note: 'less ice' }], ...over,
});
const must = <V>(r: { ok: true; value: V } | { ok: false; code: string; message: string }): V => {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
};

describe('engine: pesanan toko web', () => {
  it('membuat order take-away tertaut: event web_linked, item beserta opsi dan catatan, label untuk kasir', async () => {
    const s = await setup();
    const o = must(await s.engine.createWebOrder(web()));
    expect(o).toMatchObject({ type: 'TAKE_AWAY', webOrder: { id: 41, code: 'W41', name: 'Dewi' } });
    expect(o.items.map((l) => [l.itemId, l.qty, l.unitPrice])).toEqual([['kopi-susu', 2, 22_000], ['matcha', 1, 40_000]]); // 28.000 + large 6.000 + boba 6.000
    expect(o.items[1]!.note).toBe('less ice');
    const ev = await s.recorder.pending();
    expect(ev.filter((e) => e.type === 'order.web_linked').map((e) => e.payload)).toEqual([{ orderId: o.id, webOrderId: 41 }]);
    expect(ev.slice(-2).map((e) => e.type)).toEqual(['order.created', 'order.web_linked']); // tertaut sejak order lahir
  });

  it('dine-in memakai meja dari pesanan; tanpa meja ditolak', async () => {
    const s = await setup();
    expect(await s.engine.createWebOrder(web({ type: 'DINE_IN' }))).toMatchObject({ ok: false, code: 'TABLE_REQUIRED' });
    const o = must(await s.engine.createWebOrder(web({ type: 'DINE_IN', tableNo: '3' })));
    expect(o).toMatchObject({ type: 'DINE_IN', tableNo: '3' });
  });

  it('memeriksa menu terminal lebih dulu: menu hilang, jumlah, opsi tidak cocok; tidak ada event yang tercatat bila gagal', async () => {
    const s = await setup();
    const before = (await s.recorder.pending()).length;
    expect(s.engine.checkWebOrderItems([{ itemId: 'hantu', name: 'Menu Hantu', qty: 1, options: [] }])).toContain('Menu Hantu');
    expect(s.engine.checkWebOrderItems([{ itemId: 'kopi-susu', name: 'Kopi Susu', qty: 0, options: [] }])).toContain('Jumlah');
    expect(s.engine.checkWebOrderItems([{ itemId: 'matcha', name: 'Matcha Latte', qty: 1, options: [] }])).toContain('Matcha'); // ukuran wajib
    expect(s.engine.checkWebOrderItems([{ itemId: 'kopi-susu', name: 'Kopi Susu', qty: 1, options: ['large'] }])).toContain('Kopi Susu'); // opsi tak dikenal
    expect(s.engine.checkWebOrderItems(web().items)).toBeNull();
    expect(await s.engine.createWebOrder(web({ items: [{ itemId: 'hantu', name: 'Menu Hantu', qty: 1, options: [] }] }))).toMatchObject({ ok: false, code: 'WEB_ITEM_UNAVAILABLE' });
    expect((await s.recorder.pending()).length).toBe(before);
  });

  it('butuh shift; pesanan yang sama tidak boleh dibuat dua kali kecuali order sebelumnya di-void', async () => {
    const noShift = await setup(false);
    expect(await noShift.engine.createWebOrder(web())).toMatchObject({ ok: false, code: 'NO_SHIFT' });
    const s = await setup();
    const first = must(await s.engine.createWebOrder(web()));
    expect(await s.engine.createWebOrder(web())).toMatchObject({ ok: false, code: 'WEB_DUPLICATE' });
    expect(first.webOrder!.id).toBe(41);
  });

  it('dibayar di kasir seperti order biasa (tunai) dengan total sesuai', async () => {
    const s = await setup();
    const o = must(await s.engine.createWebOrder(web({ items: [{ itemId: 'kopi-susu', name: 'Kopi Susu', qty: 2, options: [] }] })));
    must(await s.engine.printBill(o.id));
    const total = s.engine.totals(s.engine.getOrder(o.id)!).total;
    expect(total).toBe(48_400); // 44.000 + PBJT 10%
    const paid = must(await s.engine.pay(o.id, { method: 'CASH', amount: total, tendered: 50_000 }));
    expect(paid.order.state.status).toBe('PAID');
    expect(paid.change).toBe(1_600);
  });

  it('order dari pesanan web tidak bisa diserahkan ke terminal lain (tautannya tidak ikut berpindah)', async () => {
    const s = await setup();
    const o = must(await s.engine.createWebOrder(web()));
    expect(await s.engine.handOff(o.id)).toMatchObject({ ok: false, code: 'HANDOFF_LINKED' });
  });
});
