import { describe, expect, it } from 'vitest';
import { demoConfig, MemoryStore, PosEngine, Recorder, SimPrinter } from '../src';

const T0 = Date.parse('2026-10-01T19:00:00+07:00');

async function setup() {
  const store = new MemoryStore();
  const config = await demoConfig();
  const recorder = new Recorder({ deviceId: config.deviceId, outletId: config.outletId, store, now: () => T0 });
  const engine = new PosEngine({ config, recorder, store, printer: new SimPrinter(), now: () => T0 });
  await engine.init();
  expect((await engine.login('budi', config.demoPins.budi)).ok).toBe(true);
  expect((await engine.openShift(100_000)).ok).toBe(true);
  return { engine, recorder, pins: config.demoPins };
}
const must = <V>(r: { ok: true; value: V } | { ok: false; code: string; message: string }): V => {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
};
async function billed(s: Awaited<ReturnType<typeof setup>>) {
  const o = must(await s.engine.createOrder('DINE_IN', { tableNo: '1' }));
  must(await s.engine.addItem(o.id, 'kopi-susu', 2));
  must(await s.engine.printBill(o.id));
  return o.id;
}

describe('engine: pembayaran dengan uang muka reservasi', () => {
  it('wajib menyebut reservasi; tercatat dengan reservationId, tanpa tid dan tanpa menyentuh kas laci', async () => {
    const s = await setup();
    const id = await billed(s);
    expect(await s.engine.pay(id, { method: 'DEPOSIT', amount: 10_000 })).toMatchObject({ ok: false, code: 'RESERVATION_REQUIRED' });
    expect(await s.engine.pay(id, { method: 'DEPOSIT', amount: 10_000, reservationId: 0 })).toMatchObject({ ok: false, code: 'RESERVATION_REQUIRED' });
    expect(await s.engine.pay(id, { method: 'DEPOSIT', amount: 10_000, reservationId: 1.5 })).toMatchObject({ ok: false, code: 'RESERVATION_REQUIRED' });
    const cashBefore = s.engine.currentShift()!.cashIn;
    const r = must(await s.engine.pay(id, { method: 'DEPOSIT', amount: 20_000, reservationId: 7 }));
    expect(r.order.state.status).not.toBe('PAID'); // masih ada sisa tagihan
    const e = (await s.recorder.pending()).filter((x) => x.type === 'payment.received').at(-1)!;
    expect(e.payload).toEqual({ orderId: id, method: 'DEPOSIT', amount: 20_000, reservationId: 7 });
    expect(s.engine.currentShift()!.cashIn).toBe(cashBefore);
  });

  it('boleh sebagian lalu sisanya dengan tunai; nominal tidak boleh melebihi tagihan', async () => {
    const s = await setup();
    const id = await billed(s);
    const total = s.engine.totals(s.engine.getOrder(id)!).total;
    expect(await s.engine.pay(id, { method: 'DEPOSIT', amount: total + 1, reservationId: 7 })).toMatchObject({ ok: false, code: 'AMOUNT_INVALID' });
    must(await s.engine.pay(id, { method: 'DEPOSIT', amount: 20_000, reservationId: 7 }));
    const done = must(await s.engine.pay(id, { method: 'CASH', amount: total - 20_000, tendered: total - 20_000 }));
    expect(done.order.state.status).toBe('PAID');
    expect(done.order.payments.map((p) => p.method)).toEqual(['DEPOSIT', 'CASH']);
  });

  it('refund tidak bisa dengan metode uang muka', async () => {
    const s = await setup();
    const id = await billed(s);
    const total = s.engine.totals(s.engine.getOrder(id)!).total;
    must(await s.engine.pay(id, { method: 'DEPOSIT', amount: total, reservationId: 7 }));
    const approver = { userId: 'hendra', pin: s.pins.hendra };
    expect(await s.engine.refund(id, 10_000, 'DEPOSIT', approver)).toMatchObject({ ok: false, code: 'REFUND_METHOD' });
  });
});
