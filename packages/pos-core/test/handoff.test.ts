import { describe, expect, it } from 'vitest';
import { verifyChain, type PosEvent } from '@pos/events';
import { demoConfig, MemoryStore, PosEngine, Recorder, SimPrinter, type Handoff } from '../src';

const T0 = Date.parse('2026-10-01T10:00:00+07:00');

async function terminal(deviceId: string) {
  let now = T0;
  const store = new MemoryStore();
  const config = await demoConfig('senopati', deviceId);
  const recorder = new Recorder({ deviceId, outletId: config.outletId, store, now: () => now });
  const engine = new PosEngine({ config, recorder, store, printer: new SimPrinter(), now: () => now });
  await engine.init();
  expect((await engine.login('budi', config.demoPins.budi)).ok).toBe(true);
  expect((await engine.openShift(0)).ok).toBe(true);
  return { engine, recorder, deviceId, tick: (ms: number) => { now += ms; } };
}
type T = Awaited<ReturnType<typeof terminal>>;

const must = <V>(r: { ok: true; value: V } | { ok: false; code: string; message: string }): V => {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
};

/** Salinan `order.handed_off` seperti yang akan dikembalikan server kepada terminal penerima. */
const handoffOf = async (from: T, orderId: string): Promise<Handoff> => {
  const e = (await from.recorder.pending()).find((x) => x.type === 'order.handed_off' && x.payload.orderId === orderId)!;
  if (e.type !== 'order.handed_off') throw new Error('bukan handed_off');
  return { orderId, fromDeviceId: from.deviceId, orderType: e.payload.orderType, ...(e.payload.tableNo ? { tableNo: e.payload.tableNo } : {}), items: e.payload.items, at: e.deviceTime };
};

/** Order dine-in meja 3 dengan 2 kopi susu (sudah ke dapur) dan 1 latte tambahan (belum). */
async function waiterOrder(w: T) {
  const o = must(await w.engine.createOrder('DINE_IN', { tableNo: '3' }));
  must(await w.engine.addItem(o.id, 'kopi-susu', 2));
  must(await w.engine.sendToKitchen(o.id));
  must(await w.engine.addItem(o.id, 'latte', 1));
  return o.id;
}

describe('serah-terima order antar-terminal', () => {
  it('order diserahkan terkunci di terminal asal, diambil terminal lain dengan isi dan status dapur utuh', async () => {
    const waiter = await terminal('pos-2');
    const cashier = await terminal('pos-1');
    const id = await waiterOrder(waiter);
    const before = waiter.engine.getOrder(id)!;
    const sentBefore = before.items.map((l) => [l.itemId, l.qty, l.sentQty]);

    must(await waiter.engine.handOff(id));
    const handed = waiter.engine.getOrder(id)!;
    expect(handed).toMatchObject({ handedOff: true, state: { status: 'MERGED' } });
    // terkunci: tidak bisa diubah, ditagih, atau dikirim ulang
    expect(await waiter.engine.addItem(id, 'kopi-susu', 1)).toMatchObject({ ok: false });
    expect(await waiter.engine.printBill(id)).toMatchObject({ ok: false });
    expect(await waiter.engine.handOff(id)).toMatchObject({ ok: false, code: 'HANDOFF_ALREADY' });
    expect(await waiter.engine.applyDiscount(id, { kind: 'MANUAL', percent: 5, verified: false })).toMatchObject({ ok: false, code: 'ORDER_LOCKED' });
    expect(await waiter.engine.pay(id, { method: 'CASH', amount: 1000, tendered: 1000 })).toMatchObject({ ok: false, code: 'ORDER_LOCKED' });
    expect(await waiter.engine.voidOrder(id, 'WRONG_ORDER', [])).toMatchObject({ ok: false, code: 'ORDER_LOCKED' });
    expect(await waiter.engine.setKitchenStatus(id, 'COOKING')).toMatchObject({ ok: false, code: 'ORDER_LOCKED' });

    const h = await handoffOf(waiter, id);
    expect(h.items.map((l) => [l.itemId, l.qty, l.sentQty])).toEqual(sentBefore);
    const taken = must(await cashier.engine.acceptHandoff(h));
    expect(taken).toMatchObject({ type: 'DINE_IN', tableNo: '3', takenFrom: { deviceId: 'pos-2', orderId: id }, state: { status: 'SENT' } });
    expect(taken.items.map((l) => [l.itemId, l.qty, l.sentQty])).toEqual(sentBefore);
    // item yang sudah dikirim dari terminal asal tidak dikirim lagi; hanya yang belum
    expect(cashier.engine.getOrder(taken.id)!.items.filter((l) => l.qty > l.sentQty).map((l) => l.itemId)).toEqual(['latte']);
    // harga tetap yang dicatat saat dipesan
    expect(cashier.engine.totals(taken).subtotal).toBe(waiter.engine.totals(before).subtotal);

    const events = await cashier.recorder.pending();
    expect(events.map((e) => e.type).filter((t) => t !== 'shift.opened')).toEqual(['order.created', 'order.items_moved']);
    const moved = events.find((e) => e.type === 'order.items_moved')!;
    expect(moved.payload).toMatchObject({ fromOrderId: id, toOrderId: taken.id, kind: 'MERGE', sent: true });
    for (const t of [waiter, cashier]) expect(verifyChain(await t.recorder.pending() as PosEvent[])).toEqual([]);
  });

  it('mengambil dua kali mengembalikan order yang sama (klaim ulang aman); terminal asal tidak bisa mengambil miliknya sendiri', async () => {
    const waiter = await terminal('pos-2');
    const cashier = await terminal('pos-1');
    const id = await waiterOrder(waiter);
    must(await waiter.engine.handOff(id));
    const h = await handoffOf(waiter, id);
    const a = must(await cashier.engine.acceptHandoff(h));
    const b = must(await cashier.engine.acceptHandoff(h));
    expect(b.id).toBe(a.id);
    expect(cashier.engine.listOrders()).toHaveLength(1);
    expect((await cashier.recorder.pending()).filter((e) => e.type === 'order.items_moved')).toHaveLength(1);
    expect(await waiter.engine.acceptHandoff(h)).toMatchObject({ ok: false, code: 'HANDOFF_OWN' });
  });

  it('aturan penyerahan: tanpa diskon, belum ditagih, tidak kosong, bukan makan karyawan', async () => {
    const w = await terminal('pos-2');
    const empty = must(await w.engine.createOrder('TAKE_AWAY'));
    expect(await w.engine.handOff(empty.id)).toMatchObject({ ok: false, code: 'EMPTY_ORDER' });
    must(await w.engine.addItem(empty.id, 'kopi-susu', 1));
    must(await w.engine.printBill(empty.id));
    expect(await w.engine.handOff(empty.id)).toMatchObject({ ok: false, code: 'HANDOFF_LOCKED' });

    const meal = must(await w.engine.createOrder('EMPLOYEE', { employeeId: 'sari' }));
    must(await w.engine.addItem(meal.id, 'kopi-susu', 1));
    expect(await w.engine.handOff(meal.id)).toMatchObject({ ok: false, code: 'HANDOFF_EMPLOYEE' });

    const disc = must(await w.engine.createOrder('TAKE_AWAY'));
    must(await w.engine.addItem(disc.id, 'kopi-susu', 2));
    const d = await w.engine.applyDiscount(disc.id, { kind: 'MANUAL', percent: 5, verified: false });
    expect(d.ok).toBe(true);
    expect(await w.engine.handOff(disc.id)).toMatchObject({ ok: false, code: 'HANDOFF_DISCOUNT' });
    expect((await w.recorder.pending()).some((e) => e.type === 'order.handed_off')).toBe(false);
  });

  it('tarik kembali memulihkan order (status dapur ikut benar) dan mencatat event; tutup shift ditahan selama masih diserahkan', async () => {
    const w = await terminal('pos-2');
    const id = await waiterOrder(w);
    must(await w.engine.handOff(id));
    expect(await w.engine.closeShift(0)).toMatchObject({ ok: false, code: 'OPEN_HANDOFFS' });
    must(await w.engine.reclaimHandoff(id));
    const back = w.engine.getOrder(id)!;
    expect(back).toMatchObject({ handedOff: false, state: { status: 'SENT' } });
    expect((await w.recorder.pending()).map((e) => e.type).slice(-2)).toEqual(['order.handed_off', 'order.handoff_reclaimed']);
    must(await w.engine.addItem(id, 'kopi-susu', 1)); // bisa diubah lagi
    expect(await w.engine.reclaimHandoff(id)).toMatchObject({ ok: false, code: 'HANDOFF_NONE' });
  });

  it('setelah diambil terminal lain, order asal selesai dan tidak lagi menahan tutup shift', async () => {
    const w = await terminal('pos-2');
    const id = await waiterOrder(w);
    must(await w.engine.handOff(id));
    await w.engine.finishHandoff(id, 'pos-1');
    expect(w.engine.getOrder(id)).toMatchObject({ handedOff: false, mergedInto: 'pos-1', state: { status: 'MERGED' } });
    expect(await w.engine.reclaimHandoff(id)).toMatchObject({ ok: false, code: 'HANDOFF_NONE' });
    expect((await w.engine.closeShift(0)).ok).toBe(true);
  });

  it('order yang diambil bisa ditagih di terminal penerima', async () => {
    const waiter = await terminal('pos-2');
    const cashier = await terminal('pos-1');
    const id = await waiterOrder(waiter);
    must(await waiter.engine.handOff(id));
    const taken = must(await cashier.engine.acceptHandoff(await handoffOf(waiter, id)));
    must(await cashier.engine.printBill(taken.id));
    const total = cashier.engine.totals(cashier.engine.getOrder(taken.id)!).total;
    const paid = must(await cashier.engine.pay(taken.id, { method: 'CASH', amount: total, tendered: total }));
    expect(paid.order.state.status).toBe('PAID');
  });
});
