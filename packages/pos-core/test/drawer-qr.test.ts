import { describe, expect, it } from 'vitest';
import { demoConfig, MemoryStore, PosEngine, Recorder, SimPrinter } from '../src';

const T0 = Date.parse('2026-10-01T10:00:00+07:00');

async function setup(staticQr = false) {
  const store = new MemoryStore();
  const base = await demoConfig();
  const config = { ...base, ...(staticQr ? { staticQr: true } : {}) };
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
const billed = async (s: Awaited<ReturnType<typeof setup>>) => {
  const o = must(await s.engine.createOrder('TAKE_AWAY'));
  must(await s.engine.addItem(o.id, 'kopi-susu', 1));
  must(await s.engine.printBill(o.id));
  return o.id;
};

describe('engine: laci kas', () => {
  it('pembayaran tunai mencatat drawer.opened dengan orderId; non-tunai tidak', async () => {
    const s = await setup();
    const id = await billed(s);
    must(await s.engine.pay(id, { method: 'CASH', tendered: 50_000 }));
    const ev = (await s.recorder.pending()).filter((e) => e.type === 'drawer.opened');
    expect(ev.map((e) => e.payload)).toEqual([{ orderId: id }]);
    const id2 = await billed(s);
    must(await s.engine.pay(id2, { method: 'QRIS' }));
    expect((await s.recorder.pending()).filter((e) => e.type === 'drawer.opened')).toHaveLength(1);
  });

  it('buka laci tanpa transaksi: wajib alasan dan penyetuju orang lain; tercatat dengan alasan dan penyetuju', async () => {
    const s = await setup();
    const hendra = { userId: 'hendra', pin: s.pins.hendra };
    expect(await s.engine.openDrawer('', hendra)).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(await s.engine.openDrawer('x'.repeat(61), hendra)).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect((await s.engine.openDrawer('Tukar uang kecil', { userId: 'hendra', pin: '0000' })).ok).toBe(false); // PIN salah
    expect(await s.engine.openDrawer('Tukar uang kecil', { userId: 'budi', pin: s.pins.budi })).toMatchObject({ ok: false, code: 'SELF_APPROVAL' });
    expect(await s.engine.openDrawer('Tukar uang kecil', { userId: 'sari', pin: s.pins.sari })).toMatchObject({ ok: false, code: 'APPROVER_ROLE' }); // kasir lain tidak cukup
    expect((await s.engine.openDrawer('  Tukar uang kecil  ', hendra)).ok).toBe(true);
    const e = (await s.recorder.pending()).filter((x) => x.type === 'drawer.opened');
    expect(e.map((x) => x.payload)).toEqual([{ reason: 'Tukar uang kecil', approverId: 'hendra' }]);
  });
});

describe('engine: QR statis', () => {
  it('ditolak bila outlet belum mengaktifkannya', async () => {
    const s = await setup(false);
    const id = await billed(s);
    expect(await s.engine.pay(id, { method: 'QR_STATIC' })).toMatchObject({ ok: false, code: 'STATIC_QR_OFF' });
  });

  it('bila aktif: tanpa tid, tidak menyentuh kas laci, tercatat sebagai metode QR_STATIC', async () => {
    const s = await setup(true);
    const id = await billed(s);
    const cashBefore = s.engine.currentShift()!.cashIn;
    const total = s.engine.totals(s.engine.getOrder(id)!).total;
    const r = must(await s.engine.pay(id, { method: 'QR_STATIC' }));
    expect(r.order.state.status).toBe('PAID');
    const e = (await s.recorder.pending()).find((x) => x.type === 'payment.received')!;
    expect(e.payload).toEqual({ orderId: id, method: 'QR_STATIC', amount: total });
    expect(s.engine.currentShift()!.cashIn).toBe(cashBefore);
    expect((await s.recorder.pending()).some((x) => x.type === 'drawer.opened')).toBe(false);
  });
});
