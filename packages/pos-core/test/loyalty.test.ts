import { describe, expect, it } from 'vitest';
import { demoConfig, MemoryStore, PosEngine, Recorder, SimPrinter } from '../src';

const T0 = Date.parse('2026-10-01T10:00:00+07:00');
const LOYALTY = { rupiahPerPoint: 10_000, pointValue: 100, maxRedeemPercent: 50 };
const DEWI = { id: 'm-dewi', name: 'Dewi', points: 40 };

async function setup(loyalty: typeof LOYALTY | null = LOYALTY) {
  const store = new MemoryStore();
  const base = await demoConfig();
  const config = { ...base, ...(loyalty ? { loyalty } : {}), promos: [{ id: 'hemat10', name: 'Hemat 10%', kind: 'PERCENT' as const, value: 10 }] };
  const recorder = new Recorder({ deviceId: config.deviceId, outletId: config.outletId, store, now: () => T0 });
  const engine = new PosEngine({ config, recorder, store, printer: new SimPrinter(), now: () => T0 });
  await engine.init();
  expect((await engine.login('budi', config.demoPins.budi)).ok).toBe(true);
  expect((await engine.openShift(0)).ok).toBe(true);
  return { engine, recorder, pins: config.demoPins };
}
type S = Awaited<ReturnType<typeof setup>>;
const must = <V>(r: { ok: true; value: V } | { ok: false; code: string; message: string }): V => {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
};
/** Order take-away berisi `qty` kopi susu (22.000 per cangkir). */
const order = async (s: S, qty: number) => {
  const o = must(await s.engine.createOrder('TAKE_AWAY'));
  must(await s.engine.addItem(o.id, 'kopi-susu', qty));
  return o.id;
};

describe('engine: member dan poin', () => {
  it('mengaitkan member: event tercatat, order membawa nama dan saldo yang diketahui; satu member per order', async () => {
    const s = await setup();
    const id = await order(s, 2);
    const o = must(await s.engine.linkMember(id, DEWI));
    expect(o.member).toEqual(DEWI);
    const e = (await s.recorder.pending()).find((x) => x.type === 'order.member_linked')!;
    expect(e.payload).toEqual({ orderId: id, memberId: 'm-dewi' });
    expect(await s.engine.linkMember(id, { id: 'm-lain', name: 'Lain', points: 0 })).toMatchObject({ ok: false, code: 'MEMBER_ALREADY' });
  });

  it('ditolak bila loyalty mati, untuk makan karyawan, dan untuk order yang sudah selesai atau terkunci', async () => {
    const off = await setup(null);
    expect(await off.engine.linkMember(await order(off, 1), DEWI)).toMatchObject({ ok: false, code: 'LOYALTY_OFF' });
    const s = await setup();
    const meal = must(await s.engine.createOrder('EMPLOYEE', { employeeId: 'sari' }));
    expect(await s.engine.linkMember(meal.id, DEWI)).toMatchObject({ ok: false, code: 'MEMBER_EMPLOYEE' });
    const id = await order(s, 1);
    must(await s.engine.handOff(id));
    expect(await s.engine.linkMember(id, DEWI)).toMatchObject({ ok: false, code: 'ORDER_LOCKED' });
  });

  it('menukar poin: potongan = poin × nilai per poin, dicatat sebagai POINTS terverifikasi dengan member dan jumlah poin', async () => {
    const s = await setup();
    const id = await order(s, 4); // 88.000, batas 50% = 44.000 = 440 poin; saldo 40
    must(await s.engine.linkMember(id, DEWI));
    expect(s.engine.maxRedeemablePoints(s.engine.getOrder(id)!)).toBe(40);
    const o = must(await s.engine.redeemPoints(id, 30));
    expect(o).toMatchObject({ discount: 3_000, pointsRedeemed: 30, member: { points: 10 } });
    expect(s.engine.totals(o)).toMatchObject({ subtotal: 88_000, discount: 3_000 });
    const e = (await s.recorder.pending()).find((x) => x.type === 'discount.applied')!;
    expect(e.payload).toMatchObject({ kind: 'POINTS', memberId: 'm-dewi', points: 30, amount: 3_000, verified: true });
    expect(s.engine.maxRedeemablePoints(o)).toBe(0); // sekali per order
    expect(await s.engine.redeemPoints(id, 5)).toMatchObject({ ok: false, code: 'POINTS_ALREADY' });
  });

  it('batas: saldo, persen dari subtotal, jumlah tidak sah, tanpa member', async () => {
    const s = await setup();
    const id = await order(s, 1); // 22.000, batas 50% = 11.000 = 110 poin
    expect(await s.engine.redeemPoints(id, 5)).toMatchObject({ ok: false, code: 'MEMBER_REQUIRED' });
    must(await s.engine.linkMember(id, { id: 'm-kaya', name: 'Kaya', points: 500 }));
    expect(s.engine.maxRedeemablePoints(s.engine.getOrder(id)!)).toBe(110);
    expect(await s.engine.redeemPoints(id, 111)).toMatchObject({ ok: false, code: 'POINTS_OVER_LIMIT' });
    expect(await s.engine.redeemPoints(id, 0)).toMatchObject({ ok: false, code: 'POINTS_INVALID' });
    expect(await s.engine.redeemPoints(id, 2.5)).toMatchObject({ ok: false, code: 'POINTS_INVALID' });
    const poor = await order(s, 1);
    must(await s.engine.linkMember(poor, { id: 'm-miskin', name: 'Miskin', points: 3 }));
    expect(await s.engine.redeemPoints(poor, 4)).toMatchObject({ ok: false, code: 'POINTS_INSUFFICIENT' });
    expect(must(await s.engine.redeemPoints(poor, 3)).discount).toBe(300);
    expect((await s.recorder.pending()).filter((e) => e.type === 'discount.applied')).toHaveLength(1);
  });

  it('tidak digabung dengan promo atau diskon lain, ke segala arah', async () => {
    const s = await setup();
    const a = await order(s, 4);
    must(await s.engine.linkMember(a, DEWI));
    must(await s.engine.redeemPoints(a, 10));
    expect(await s.engine.applyPromo(a, 'hemat10')).toMatchObject({ ok: false, code: 'PROMO_STACK' });
    expect(await s.engine.applyDiscount(a, { kind: 'MANUAL', percent: 5, verified: false })).toMatchObject({ ok: false, code: 'DISCOUNT_STACK' });

    const b = await order(s, 4);
    must(await s.engine.linkMember(b, DEWI));
    must(await s.engine.applyPromo(b, 'hemat10'));
    expect(await s.engine.redeemPoints(b, 10)).toMatchObject({ ok: false, code: 'DISCOUNT_STACK' });
    expect(s.engine.maxRedeemablePoints(s.engine.getOrder(b)!)).toBe(0);

    const c = await order(s, 4);
    must(await s.engine.linkMember(c, DEWI));
    must(await s.engine.applyDiscount(c, { kind: 'MANUAL', percent: 5, verified: false }));
    expect(await s.engine.redeemPoints(c, 10)).toMatchObject({ ok: false, code: 'DISCOUNT_STACK' });
  });

  it('setelah tagihan dicetak penukaran memerlukan persetujuan supervisor yang bukan pelaku', async () => {
    const s = await setup();
    const id = await order(s, 4);
    must(await s.engine.linkMember(id, DEWI));
    must(await s.engine.printBill(id));
    expect(await s.engine.redeemPoints(id, 10)).toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
    expect(await s.engine.redeemPoints(id, 10, { approver: { userId: 'budi', pin: s.pins.budi } })).toMatchObject({ ok: false });
    expect(must(await s.engine.redeemPoints(id, 10, { approver: { userId: 'hendra', pin: s.pins.hendra } })).pointsRedeemed).toBe(10);
  });

  it('order yang sudah dikaitkan ke member tidak bisa diserahkan ke terminal lain (member tidak ikut berpindah)', async () => {
    const s = await setup();
    const id = await order(s, 2);
    must(await s.engine.linkMember(id, DEWI));
    expect(await s.engine.handOff(id)).toMatchObject({ ok: false, code: 'HANDOFF_MEMBER' });
  });
});
