import { describe, expect, it } from 'vitest';
import { demoConfig, MemoryStore, PosEngine, Recorder, SimPrinter } from '../src';

const T0 = Date.parse('2026-10-01T10:00:00+07:00');
const CHANNELS = [{ channel: 'GOFOOD' as const, commissionPercent: 20 }, { channel: 'GRABFOOD' as const, commissionPercent: 25 }];

async function setup(channels: typeof CHANNELS | null = CHANNELS) {
  const store = new MemoryStore();
  const base = await demoConfig();
  const config = { ...base, ...(channels ? { channels } : {}), loyalty: { rupiahPerPoint: 10_000, pointValue: 100, maxRedeemPercent: 50 }, promos: [{ id: 'hemat10', name: 'Hemat', kind: 'PERCENT' as const, value: 10 }] };
  const recorder = new Recorder({ deviceId: config.deviceId, outletId: config.outletId, store, now: () => T0 });
  const engine = new PosEngine({ config, recorder, store, printer: new SimPrinter(), now: () => T0 });
  await engine.init();
  expect((await engine.login('budi', config.demoPins.budi)).ok).toBe(true);
  expect((await engine.openShift(0)).ok).toBe(true);
  return { engine, recorder };
}
type S = Awaited<ReturnType<typeof setup>>;
const must = <V>(r: { ok: true; value: V } | { ok: false; code: string; message: string }): V => {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
};
const online = async (s: S, ref = 'GF-1001', channel: 'GOFOOD' | 'GRABFOOD' = 'GOFOOD') => {
  const o = must(await s.engine.createOnlineOrder(channel, ref));
  must(await s.engine.addItem(o.id, 'kopi-susu', 2));
  must(await s.engine.printBill(o.id));
  return o.id;
};

describe('engine: pesanan online', () => {
  it('membuat order take-away yang dikaitkan ke kanal; event tercatat; label memuat kanal dan nomor', async () => {
    const s = await setup();
    const o = must(await s.engine.createOnlineOrder('GOFOOD', ' GF-1001 '));
    expect(o).toMatchObject({ type: 'TAKE_AWAY', channel: { channel: 'GOFOOD', ref: 'GF-1001' } });
    const types = (await s.recorder.pending()).map((e) => e.type);
    expect(types.slice(-2)).toEqual(['order.created', 'order.channel_linked']);
    expect((await s.recorder.pending()).find((e) => e.type === 'order.channel_linked')!.payload).toEqual({ orderId: o.id, channel: 'GOFOOD', ref: 'GF-1001' });
  });

  it('kanal harus aktif; nomor pesanan sah; nomor yang sama (tanpa peduli huruf) ditolak sampai order sebelumnya di-void, kanal lain boleh', async () => {
    const off = await setup(null);
    expect(await off.engine.createOnlineOrder('GOFOOD', 'GF-1')).toMatchObject({ ok: false, code: 'CHANNEL_OFF' });
    const s = await setup();
    expect(await s.engine.createOnlineOrder('SHOPEEFOOD', 'SF-1001')).toMatchObject({ ok: false, code: 'CHANNEL_OFF' }); // tidak diaktifkan outlet ini
    for (const bad of ['', 'ab', 'a b c', 'x'.repeat(31), 'GF/1']) expect(await s.engine.createOnlineOrder('GOFOOD', bad), bad).toMatchObject({ ok: false, code: 'REF_INVALID' });
    const first = must(await s.engine.createOnlineOrder('GOFOOD', 'GF-1001'));
    expect(await s.engine.createOnlineOrder('GOFOOD', 'gf-1001')).toMatchObject({ ok: false, code: 'REF_DUPLICATE' });
    expect(must(await s.engine.createOnlineOrder('GRABFOOD', 'GF-1001')).channel!.channel).toBe('GRABFOOD');
    expect(first.channel!.ref).toBe('GF-1001');
  });

  it('dibayar platform sebesar seluruh tagihan, tanpa tid dan tanpa menyentuh kas laci', async () => {
    const s = await setup();
    const id = await online(s);
    const total = s.engine.totals(s.engine.getOrder(id)!).total;
    expect(await s.engine.pay(id, { method: 'PLATFORM', amount: total - 1000 })).toMatchObject({ ok: false, code: 'PLATFORM_FULL' });
    const paid = must(await s.engine.pay(id, { method: 'PLATFORM' }));
    expect(paid.order.state.status).toBe('PAID');
    const e = (await s.recorder.pending()).find((x) => x.type === 'payment.received')!;
    expect(e.payload).toEqual({ orderId: id, method: 'PLATFORM', amount: total });
    expect(s.engine.currentShift()).toMatchObject({ cashIn: 0 });
  });

  it('order online hanya boleh metode Platform; metode Platform hanya untuk order online', async () => {
    const s = await setup();
    const id = await online(s);
    for (const method of ['CASH', 'QRIS', 'EDC_DEBIT'] as const) expect(await s.engine.pay(id, { method, tendered: 999_999, tid: '12345678' }), method).toMatchObject({ ok: false, code: 'CHANNEL_PLATFORM_ONLY' });
    const walkIn = must(await s.engine.createOrder('TAKE_AWAY'));
    must(await s.engine.addItem(walkIn.id, 'kopi-susu', 1));
    must(await s.engine.printBill(walkIn.id));
    expect(await s.engine.pay(walkIn.id, { method: 'PLATFORM' })).toMatchObject({ ok: false, code: 'PLATFORM_NOT_ONLINE' });
  });

  it('tanpa diskon, promo, tukar poin, member, atau serah-terima pada order online', async () => {
    const s = await setup();
    const o = must(await s.engine.createOnlineOrder('GOFOOD', 'GF-1'));
    must(await s.engine.addItem(o.id, 'kopi-susu', 4));
    expect(await s.engine.applyDiscount(o.id, { kind: 'MANUAL', percent: 5, verified: false })).toMatchObject({ ok: false, code: 'DISCOUNT_ONLINE' });
    expect(await s.engine.applyPromo(o.id, 'hemat10')).toMatchObject({ ok: false, code: 'DISCOUNT_ONLINE' });
    expect(await s.engine.linkMember(o.id, { id: 'm1', name: 'Dewi', points: 10 })).toMatchObject({ ok: false, code: 'MEMBER_ONLINE' });
    expect(await s.engine.handOff(o.id)).toMatchObject({ ok: false, code: 'HANDOFF_ONLINE' });
    expect((await s.recorder.pending()).some((e) => e.type === 'discount.applied')).toBe(false);
  });
});
