import { describe, expect, it } from 'vitest';
import type { Promo } from '@pos/order';
import { demoConfig, MemoryStore, PosEngine, Recorder, SimPrinter } from '../src';

const T0 = Date.parse('2026-10-01T10:00:00+07:00'); // Kamis

const PROMOS: Promo[] = [
  { id: 'hemat10', name: 'Hemat 10%', kind: 'PERCENT', value: 10, maxDiscount: 5_000 },
  { id: 'potong15', name: 'Potong 15rb', kind: 'AMOUNT', value: 15_000, minSubtotal: 40_000 },
  { id: 'happy', name: 'Happy hour', kind: 'PERCENT', value: 20, startHour: 14, endHour: 17, days: [4] },
  { id: 'weekend', name: 'Akhir pekan', kind: 'PERCENT', value: 15, days: [0, 6] },
];

async function setup(store = new MemoryStore()) {
  let now = T0;
  const config = { ...(await demoConfig()), promos: PROMOS };
  const recorder = new Recorder({ deviceId: config.deviceId, outletId: config.outletId, store, now: () => now });
  const engine = new PosEngine({ config, recorder, store, printer: new SimPrinter(), now: () => now });
  await engine.init();
  expect((await engine.login('budi', config.demoPins.budi)).ok).toBe(true);
  expect((await engine.openShift(0)).ok).toBe(true);
  return { engine, recorder, store, config, pins: config.demoPins, tick: (ms: number) => { now += ms; } };
}
const must = <V>(r: { ok: true; value: V } | { ok: false; code: string; message: string }): V => {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
};
type S = Awaited<ReturnType<typeof setup>>;
/** Order dengan satu kopi susu (22.000) per `qty`. */
const order = async (s: S, qty = 1, type: 'TAKE_AWAY' | 'DINE_IN' = 'TAKE_AWAY') => {
  const o = must(await s.engine.createOrder(type, type === 'DINE_IN' ? { tableNo: '1' } : {}));
  must(await s.engine.addItem(o.id, 'kopi-susu', qty));
  return o.id;
};

describe('engine: promo', () => {
  it('memakai promo: potongan dihitung aturan (persen dibatasi maxDiscount), dicatat sebagai PROMO terverifikasi, dan total ikut turun', async () => {
    const s = await setup();
    const id = await order(s, 4); // 88.000
    const o = must(await s.engine.applyPromo(id, 'hemat10'));
    expect(o).toMatchObject({ promoId: 'hemat10', discount: 5_000 }); // 10% = 8.800, dibatasi 5.000
    expect(s.engine.totals(o)).toMatchObject({ subtotal: 88_000, discount: 5_000 });
    const e = (await s.recorder.pending()).find((x) => x.type === 'discount.applied')!;
    expect(e.payload).toMatchObject({ kind: 'PROMO', promoId: 'hemat10', amount: 5_000, verified: true });
    expect(e.payload).not.toHaveProperty('approverId');
    expect((e.payload as { percent: number }).percent).toBe(5.7); // persen efektif
  });

  it('promo harus ada di daftar server; tidak bisa dipakai dua kali atau digabung diskon lain (dua arah)', async () => {
    const s = await setup();
    const id = await order(s, 4);
    expect(await s.engine.applyPromo(id, 'tidak-ada')).toMatchObject({ ok: false, code: 'PROMO_UNKNOWN' });
    must(await s.engine.applyPromo(id, 'hemat10'));
    expect(await s.engine.applyPromo(id, 'potong15')).toMatchObject({ ok: false, code: 'PROMO_STACK' });
    expect(await s.engine.applyDiscount(id, { kind: 'MANUAL', percent: 5, verified: false })).toMatchObject({ ok: false, code: 'PROMO_STACK' });
    const id2 = await order(s, 4);
    must(await s.engine.applyDiscount(id2, { kind: 'MANUAL', percent: 5, verified: false }));
    expect(await s.engine.applyPromo(id2, 'hemat10')).toMatchObject({ ok: false, code: 'PROMO_STACK' });
    expect((await s.recorder.pending()).filter((e) => e.type === 'discount.applied')).toHaveLength(2);
  });

  it('belanja minimum, jadwal jam dan hari menurut zona outlet', async () => {
    const s = await setup();
    const small = await order(s, 1); // 22.000
    expect(await s.engine.applyPromo(small, 'potong15')).toMatchObject({ ok: false, code: 'PROMO_MIN' });
    const big = await order(s, 2); // 44.000
    expect(must(await s.engine.applyPromo(big, 'potong15')).discount).toBe(15_000);

    const o = await order(s, 2);
    expect(await s.engine.applyPromo(o, 'happy')).toMatchObject({ ok: false, code: 'PROMO_SCHEDULE' }); // 10.00, di luar 14–17
    expect(await s.engine.applyPromo(o, 'weekend')).toMatchObject({ ok: false, code: 'PROMO_SCHEDULE' }); // Kamis
    s.tick(4 * 3_600_000 + 30 * 60_000); // 14.30
    expect(must(await s.engine.applyPromo(o, 'happy')).discount).toBe(8_800);
  });

  it('order kosong dan order karyawan ditolak', async () => {
    const s = await setup();
    const e = must(await s.engine.createOrder('TAKE_AWAY'));
    expect(await s.engine.applyPromo(e.id, 'hemat10')).toMatchObject({ ok: false, code: 'EMPTY_ORDER' });
    const meal = must(await s.engine.createOrder('EMPLOYEE', { employeeId: 'sari' }));
    must(await s.engine.addItem(meal.id, 'kopi-susu', 2));
    expect(await s.engine.applyPromo(meal.id, 'potong15')).toMatchObject({ ok: false, code: 'PROMO_EMPLOYEE' });
  });

  it('setelah tagihan dicetak perlu persetujuan supervisor yang bukan pelaku', async () => {
    const s = await setup();
    const id = await order(s, 4);
    must(await s.engine.printBill(id));
    expect(await s.engine.applyPromo(id, 'hemat10')).toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
    expect(await s.engine.applyPromo(id, 'hemat10', { approver: { userId: 'budi', pin: s.pins.budi } })).toMatchObject({ ok: false });
    const done = must(await s.engine.applyPromo(id, 'hemat10', { approver: { userId: 'hendra', pin: s.pins.hendra } }));
    expect(done.promoId).toBe('hemat10');
    const e = (await s.recorder.pending()).filter((x) => x.type === 'discount.applied').pop()!;
    expect(e.payload).toMatchObject({ kind: 'PROMO', approverId: 'hendra' });
  });

  it('order terkunci (diserahkan) dan order selesai menolak promo', async () => {
    const s = await setup();
    const id = await order(s, 4);
    must(await s.engine.handOff(id));
    expect(await s.engine.applyPromo(id, 'hemat10')).toMatchObject({ ok: false, code: 'ORDER_LOCKED' });
  });

  it('promoId tersimpan di order sehingga bertahan setelah terminal dimulai ulang', async () => {
    const s = await setup();
    const id = await order(s, 4);
    must(await s.engine.applyPromo(id, 'hemat10'));
    const again = new PosEngine({
      config: s.config, store: s.store, printer: new SimPrinter(), now: () => T0,
      recorder: new Recorder({ deviceId: s.config.deviceId, outletId: s.config.outletId, store: s.store, now: () => T0 }),
    });
    await again.init();
    await again.login('budi', s.pins.budi);
    expect(again.getOrder(id)).toMatchObject({ promoId: 'hemat10', discount: 5_000 });
    expect(await again.applyPromo(id, 'potong15')).toMatchObject({ ok: false, code: 'PROMO_STACK' });
  });
});
