import { describe, expect, it } from 'vitest';
import { demoConfig, MemoryStore, PosEngine, Recorder, SimPrinter, type ChannelOrderInput } from '../src';

const T0 = Date.parse('2026-10-01T12:00:00+07:00');

async function setup(channels = true, openShift = true) {
  const store = new MemoryStore();
  const base = await demoConfig();
  const config = { ...base, ...(channels ? { channels: [{ channel: 'GOFOOD' as const, commissionPercent: 20 }] } : {}) };
  const recorder = new Recorder({ deviceId: config.deviceId, outletId: config.outletId, store, now: () => T0 });
  const engine = new PosEngine({ config, recorder, store, printer: new SimPrinter(), now: () => T0 });
  await engine.init();
  expect((await engine.login('budi', config.demoPins.budi)).ok).toBe(true);
  if (openShift) expect((await engine.openShift(0)).ok).toBe(true);
  return { engine, recorder };
}
const input = (over: Partial<ChannelOrderInput> = {}): ChannelOrderInput => ({
  channel: 'GOFOOD', ref: 'GF-1001', items: [{ itemId: 'kopi-susu', name: 'Kopi Susu', qty: 2 }, { itemId: 'kopi-susu', name: 'Kopi Susu', qty: 1, note: 'less ice' }], ...over,
});

describe('engine: pesanan GoFood/GrabFood/ShopeeFood masuk langsung', () => {
  it('membuat order online tertaut ke kanal dan nomor pesanan, item ditambahkan, langsung dikirim ke dapur', async () => {
    const s = await setup();
    const r = await s.engine.createChannelOrder(input());
    if (!r.ok) throw new Error(r.message);
    expect(r.value).toMatchObject({ type: 'TAKE_AWAY', channel: { channel: 'GOFOOD', ref: 'GF-1001' } });
    expect(r.value.items.map((l) => [l.itemId, l.qty, l.sentQty, l.note ?? null])).toEqual([['kopi-susu', 2, 2, null], ['kopi-susu', 1, 1, 'less ice']]);
    const types = (await s.recorder.pending()).map((e) => e.type);
    expect(types.slice(-3)).toEqual(['order.created', 'order.channel_linked', 'order.sent_to_kitchen']); // item masuk ke event lewat pengiriman ke dapur
  });

  it('menolak sebelum ada event: kanal mati, menu tidak ada di terminal ini, jumlah tidak sah, menu butuh pilihan wajib', async () => {
    const off = await setup(false);
    const before = (await off.recorder.pending()).length;
    expect(await off.engine.createChannelOrder(input())).toMatchObject({ ok: false, code: 'CHANNEL_ITEM_UNAVAILABLE' });
    expect((await off.recorder.pending()).length).toBe(before);
    const s = await setup();
    const n = (await s.recorder.pending()).length;
    expect(s.engine.checkChannelOrder(input())).toBeNull();
    expect(s.engine.checkChannelOrder(input({ channel: 'GRABFOOD' }))).toContain('belum diaktifkan');
    expect(s.engine.checkChannelOrder(input({ items: [{ itemId: 'hantu', name: 'Menu Hantu', qty: 1 }] }))).toContain('Menu Hantu');
    expect(s.engine.checkChannelOrder(input({ items: [{ itemId: 'kopi-susu', name: 'Kopi Susu', qty: 0 }] }))).toContain('Jumlah');
    expect(s.engine.checkChannelOrder(input({ items: [{ itemId: 'matcha', name: 'Matcha Latte', qty: 1 }] }))).toContain('Matcha'); // ukuran wajib
    expect(await s.engine.createChannelOrder(input({ items: [{ itemId: 'hantu', name: 'Menu Hantu', qty: 1 }] }))).toMatchObject({ ok: false, code: 'CHANNEL_ITEM_UNAVAILABLE' });
    expect((await s.recorder.pending()).length).toBe(n);
  });

  it('butuh shift; nomor pesanan yang sama tidak boleh dibuat dua kali; nomor tidak sah ditolak', async () => {
    const noShift = await setup(true, false);
    expect(await noShift.engine.createChannelOrder(input())).toMatchObject({ ok: false, code: 'NO_SHIFT' });
    const s = await setup();
    expect((await s.engine.createChannelOrder(input())).ok).toBe(true);
    expect(await s.engine.createChannelOrder(input())).toMatchObject({ ok: false, code: 'REF_DUPLICATE' });
    expect(await s.engine.createChannelOrder(input({ ref: 'a b' }))).toMatchObject({ ok: false, code: 'REF_INVALID' });
  });
});
