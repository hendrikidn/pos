import { describe, expect, it } from 'vitest';
import { demoConfig, MemoryStore, PosEngine, Recorder, SimPrinter } from '../src';

const T0 = Date.parse('2026-10-01T19:00:00+07:00');
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

describe('engine: order dari antrian', () => {
  it('membuat order dine-in di meja yang dipilih, tertaut ke tiket (event queue_linked); label untuk kasir', async () => {
    const s = await setup();
    const r = await s.engine.createQueueOrder({ ticketId: 12, label: 'A012', tableNo: '5' });
    expect(r.ok && r.value).toMatchObject({ type: 'DINE_IN', tableNo: '5', queue: { id: 12, label: 'A012' } });
    const ev = await s.recorder.pending();
    expect(ev.slice(-2).map((e) => e.type)).toEqual(['order.created', 'order.queue_linked']);
    expect(ev.at(-1)!.payload).toEqual({ orderId: (r as { value: { id: string } }).value.id, ticketId: 12 });
  });

  it('butuh shift; tiket sah; satu tiket satu order kecuali yang lama di-void', async () => {
    const noShift = await setup(false);
    expect(await noShift.engine.createQueueOrder({ ticketId: 1, label: 'A001', tableNo: '1' })).toMatchObject({ ok: false, code: 'NO_SHIFT' });
    const s = await setup();
    expect(await s.engine.createQueueOrder({ ticketId: 0, label: 'A000', tableNo: '1' })).toMatchObject({ ok: false, code: 'QUEUE_INVALID' });
    expect((await s.engine.createQueueOrder({ ticketId: 3, label: 'A003', tableNo: '2' })).ok).toBe(true);
    expect(await s.engine.createQueueOrder({ ticketId: 3, label: 'A003', tableNo: '2' })).toMatchObject({ ok: false, code: 'QUEUE_DUPLICATE' });
  });

  it('order dari antrian tidak bisa diserahkan ke terminal lain (tautannya tidak ikut berpindah)', async () => {
    const s = await setup();
    const o = await s.engine.createQueueOrder({ ticketId: 5, label: 'A005', tableNo: '3' });
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    await s.engine.addItem(o.value.id, 'kopi-susu', 1);
    expect(await s.engine.handOff(o.value.id)).toMatchObject({ ok: false, code: 'HANDOFF_LINKED' });
  });
});
