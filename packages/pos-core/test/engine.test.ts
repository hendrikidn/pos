import { beforeEach, describe, expect, it } from 'vitest';
import { verifyChain, type PosEvent } from '@pos/events';
import { DEFAULT_POLICY } from '@pos/order';
import { demoConfig, MemoryStore, PosEngine, Recorder, SimPrinter } from '../src';

const T0 = Date.parse('2026-10-01T10:00:00+07:00');

async function setup(opts: { printer?: SimPrinter } = {}) {
  let now = T0;
  const store = new MemoryStore();
  const printer = opts.printer ?? new SimPrinter();
  const config = await demoConfig();
  const recorder = new Recorder({ deviceId: config.deviceId, outletId: config.outletId, store, now: () => now });
  const engine = new PosEngine({ config, recorder, store, printer, now: () => now });
  await engine.init();
  return {
    engine, recorder, store, printer, pins: config.demoPins,
    tick: (ms: number) => { now += ms; },
    types: async () => (await recorder.pending()).map((e) => e.type),
    events: () => recorder.pending(),
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const login = async (c: Ctx, id: keyof Ctx['pins']) => {
  const r = await c.engine.login(id, c.pins[id]);
  expect(r.ok).toBe(true);
};
const must = <T>(r: { ok: true; value: T } | { ok: false; code: string; message: string }): T => {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
};

/** Order take-away berisi dua kopi, sudah ditagih. */
async function billedOrder(c: Ctx) {
  const o = must(await c.engine.createOrder('TAKE_AWAY'));
  must(await c.engine.addItem(o.id, 'kopi-susu', 2));
  must(await c.engine.printBill(o.id));
  return o.id;
}

describe('sesi dan shift', () => {
  let c: Ctx;
  beforeEach(async () => { c = await setup(); });

  it('PIN salah ditolak dan terkunci setelah 5 kali, lalu terbuka lagi setelah 1 menit', async () => {
    for (let i = 0; i < 5; i++) expect(await c.engine.login('budi', '0000')).toMatchObject({ ok: false, code: 'PIN_WRONG' });
    expect(await c.engine.login('budi', c.pins.budi)).toMatchObject({ ok: false, code: 'PIN_LOCKED' });
    c.tick(61_000);
    expect((await c.engine.login('budi', c.pins.budi)).ok).toBe(true);
  });

  it('tanpa login atau tanpa shift, order tidak bisa dibuat', async () => {
    expect(await c.engine.createOrder('TAKE_AWAY')).toMatchObject({ code: 'NOT_LOGGED_IN' });
    await login(c, 'budi');
    expect(await c.engine.createOrder('TAKE_AWAY')).toMatchObject({ code: 'NO_SHIFT' });
  });

  it('tutup shift: hitungan buta, event memuat jumlah yang diharapkan tetapi tidak dikembalikan ke kasir', async () => {
    await login(c, 'budi');
    must(await c.engine.openShift(100_000));
    const id = await billedOrder(c);
    const total = c.engine.totals(c.engine.getOrder(id)!).total; // 2 × 22.000 + 10% = 48.400
    must(await c.engine.pay(id, { method: 'CASH', tendered: 50_000 }));
    must(await c.engine.declineReceipt(id, 'CUSTOMER_DECLINED'));

    const closed = await c.engine.closeShift(148_000);
    expect(closed).toEqual({ ok: true, value: undefined });
    const counted = (await c.events()).find((e) => e.type === 'cash.counted')!;
    expect(counted.type === 'cash.counted' && counted.payload).toMatchObject({ counted: 148_000, expected: 100_000 + total });
    expect(c.engine.currentShift()).toBeNull();
  });

  it('shift tidak bisa ditutup selama masih ada order yang belum selesai', async () => {
    await login(c, 'budi');
    must(await c.engine.openShift(0));
    await billedOrder(c);
    expect(await c.engine.closeShift(0)).toMatchObject({ ok: false, code: 'OPEN_ORDERS' });
  });
});

describe('alur order normal', () => {
  let c: Ctx;
  beforeEach(async () => {
    c = await setup();
    await login(c, 'budi');
    must(await c.engine.openShift(0));
  });

  it('menghasilkan urutan event yang benar dan rantai hash yang utuh', async () => {
    const o = must(await c.engine.createOrder('DINE_IN', { tableNo: '7' }));
    must(await c.engine.addItem(o.id, 'latte', 1));
    must(await c.engine.sendToKitchen(o.id));
    must(await c.engine.printBill(o.id));
    const paid = must(await c.engine.pay(o.id, { method: 'CASH', tendered: 50_000 }));
    expect(paid.change).toBe(50_000 - 28_600); // 26.000 + PBJT 10%
    must(await c.engine.printReceipt(o.id));

    expect(await c.types()).toEqual([
      'shift.opened', 'order.created', 'order.sent_to_kitchen', 'bill.printed', 'payment.received', 'receipt.printed',
    ]);
    expect(verifyChain(await c.events())).toEqual([]);
    expect(c.engine.getOrder(o.id)!.state.status).toBe('PAID');
  });

  it('item yang sudah dikirim ke dapur tidak bisa dikurangi atau dihapus', async () => {
    const o = must(await c.engine.createOrder('TAKE_AWAY'));
    must(await c.engine.addItem(o.id, 'kopi-susu', 2));
    must(await c.engine.sendToKitchen(o.id));
    expect(await c.engine.setQty(o.id, 'kopi-susu', 1)).toMatchObject({ code: 'ITEM_SENT' });
    expect(await c.engine.setQty(o.id, 'kopi-susu', 0)).toMatchObject({ code: 'ITEM_SENT' });
    must(await c.engine.setQty(o.id, 'kopi-susu', 3)); // menambah boleh
    must(await c.engine.sendToKitchen(o.id));
    expect(c.engine.getOrder(o.id)!.items[0]).toMatchObject({ qty: 3, sentQty: 3 });
  });

  it('item tidak bisa diubah setelah ditagih', async () => {
    const id = await billedOrder(c);
    expect(await c.engine.addItem(id, 'teh')).toMatchObject({ code: 'ORDER_LOCKED' });
  });

  it('pembayaran mensyaratkan bill dan mesin EDC terdaftar', async () => {
    const o = must(await c.engine.createOrder('TAKE_AWAY'));
    must(await c.engine.addItem(o.id, 'teh', 1));
    expect(await c.engine.pay(o.id, { method: 'CASH' })).toMatchObject({ code: 'BILL_REQUIRED' });
    must(await c.engine.printBill(o.id));
    expect(await c.engine.pay(o.id, { method: 'QRIS', tid: 'EDC-LIAR' })).toMatchObject({ code: 'EDC_UNKNOWN' });
    const r = must(await c.engine.pay(o.id, { method: 'QRIS' })); // satu EDC terdaftar: dipilih otomatis
    const ev = (await c.events()).find((e) => e.type === 'payment.received')!;
    expect(ev.type === 'payment.received' && ev.payload).toMatchObject({ method: 'QRIS', tid: '12345678', amount: 19_800 });
    expect(r.order.state.status).toBe('PAID');
  });

  it('uang diterima kurang dari tagihan ditolak', async () => {
    const id = await billedOrder(c);
    expect(await c.engine.pay(id, { method: 'CASH', tendered: 10_000 })).toMatchObject({ code: 'TENDERED_TOO_LOW' });
  });

  it('pembayaran sebagian: order lunas setelah sisa dibayar', async () => {
    const id = await billedOrder(c); // 48.400
    must(await c.engine.pay(id, { method: 'CASH', amount: 20_000, tendered: 20_000 }));
    expect(c.engine.getOrder(id)!.state.status).toBe('BILLED');
    expect(c.engine.outstanding(c.engine.getOrder(id)!)).toBe(28_400);
    must(await c.engine.pay(id, { method: 'QRIS' }));
    expect(c.engine.getOrder(id)!.state.status).toBe('PAID');
  });
});

describe('kunci void, diskon, dan refund', () => {
  let c: Ctx;
  beforeEach(async () => {
    c = await setup();
    await login(c, 'budi');
    must(await c.engine.openShift(0));
  });

  it('void sebelum dikirim ke dapur: tanpa persetujuan', async () => {
    const o = must(await c.engine.createOrder('TAKE_AWAY'));
    must(await c.engine.addItem(o.id, 'teh'));
    must(await c.engine.voidOrder(o.id, 'WRONG_ORDER', []));
    expect(c.engine.getOrder(o.id)!.state.status).toBe('VOIDED');
  });

  it('void setelah ditagih: butuh supervisor, PIN salah ditolak, tidak ada event yang tercatat saat ditolak', async () => {
    const id = await billedOrder(c);
    const before = (await c.events()).length;
    expect(await c.engine.voidOrder(id, 'CUSTOMER_CANCEL', [])).toMatchObject({ code: 'NOT_ENOUGH_APPROVERS' });
    expect(await c.engine.voidOrder(id, 'CUSTOMER_CANCEL', [{ userId: 'hendra', pin: '0000' }])).toMatchObject({ code: 'PIN_WRONG' });
    expect(await c.engine.voidOrder(id, 'CUSTOMER_CANCEL', [{ userId: 'sari', pin: c.pins.sari }])).toMatchObject({ code: 'APPROVER_ROLE_TOO_LOW' });
    expect((await c.events()).length).toBe(before);
    must(await c.engine.voidOrder(id, 'CUSTOMER_CANCEL', [{ userId: 'hendra', pin: c.pins.hendra }]));
    expect(c.engine.getOrder(id)!.state.status).toBe('VOIDED');
  });

  it('kasir tidak bisa menyetujui voidnya sendiri', async () => {
    const id = await billedOrder(c);
    expect(await c.engine.voidOrder(id, 'CUSTOMER_CANCEL', [{ userId: 'budi', pin: c.pins.budi }])).toMatchObject({ code: 'SELF_APPROVAL' });
  });

  it('void setelah dibayar wajib owner', async () => {
    const id = await billedOrder(c);
    must(await c.engine.pay(id, { method: 'CASH', tendered: 50_000 }));
    expect(await c.engine.voidOrder(id, 'CUSTOMER_CANCEL', [{ userId: 'rina', pin: c.pins.rina }])).toMatchObject({ code: 'OWNER_REQUIRED' });
    must(await c.engine.voidOrder(id, 'CUSTOMER_CANCEL', [{ userId: 'owner', pin: c.pins.owner }]));
  });

  it('alasan void harus dari daftar baku', async () => {
    const o = must(await c.engine.createOrder('TAKE_AWAY'));
    expect(await c.engine.voidOrder(o.id, 'customer tidak ambil struk', [])).toMatchObject({ code: 'REASON_INVALID' });
  });

  it('diskon setelah bill: butuh persetujuan; diskon kecil sebelum bill: tidak', async () => {
    const o = must(await c.engine.createOrder('TAKE_AWAY'));
    must(await c.engine.addItem(o.id, 'kopi-susu', 2)); // 44.000
    must(await c.engine.applyDiscount(o.id, { kind: 'MANUAL', percent: 10, verified: false })); // 4.400
    must(await c.engine.printBill(o.id));
    expect(await c.engine.applyDiscount(o.id, { kind: 'MEMBER', amount: 2_000, verified: true })).toMatchObject({ code: 'APPROVAL_REQUIRED' });
    must(await c.engine.applyDiscount(o.id, { kind: 'MEMBER', amount: 2_000, verified: true, approver: { userId: 'hendra', pin: c.pins.hendra } }));
    expect(c.engine.getOrder(o.id)!.discount).toBe(6_400);
  });

  it('diskon manual besar tanpa verifikasi butuh persetujuan', async () => {
    const o = must(await c.engine.createOrder('TAKE_AWAY'));
    must(await c.engine.addItem(o.id, 'wagyu-bowl', 1));
    expect(await c.engine.applyDiscount(o.id, { kind: 'MANUAL', percent: 30, verified: false })).toMatchObject({ code: 'APPROVAL_REQUIRED' });
  });

  it('refund: order lunas, approver supervisor, dan tercatat memengaruhi hitungan kas', async () => {
    must(await c.engine.closeShift(0).then(() => ({ ok: true as const, value: 0 }))); // shift kosong boleh ditutup
    must(await c.engine.openShift(0));
    const id = await billedOrder(c);
    must(await c.engine.pay(id, { method: 'CASH', tendered: 50_000 }));
    must(await c.engine.declineReceipt(id, 'CUSTOMER_DECLINED'));
    expect(await c.engine.refund(id, 10_000, 'CASH', { userId: 'hendra', pin: '0000' })).toMatchObject({ code: 'PIN_WRONG' });
    must(await c.engine.refund(id, 10_000, 'CASH', { userId: 'hendra', pin: c.pins.hendra }));
    must(await c.engine.closeShift(38_400));
    const counted = (await c.events()).filter((e) => e.type === 'cash.counted').at(-1)!;
    expect(counted.type === 'cash.counted' && counted.payload.expected).toBe(48_400 - 10_000);
  });
});

describe('struk dan printer', () => {
  it('struk gagal dicetak saat kertas habis; penolakan struk dicatat dengan alasan', async () => {
    const printer = new SimPrinter();
    const c = await setup({ printer });
    await login(c, 'budi');
    must(await c.engine.openShift(0));
    const id = await billedOrder(c);
    must(await c.engine.pay(id, { method: 'CASH', tendered: 50_000 }));

    printer.paper = false;
    expect(await c.engine.printReceipt(id)).toMatchObject({ code: 'PRINT_FAILED' });
    must(await c.engine.declineReceipt(id, 'NO_PAPER'));
    const ev = (await c.events()).find((e) => e.type === 'receipt.declined')!;
    expect(ev.type === 'receipt.declined' && ev.payload.reason).toBe('NO_PAPER');
    expect(await c.engine.printReceipt(id)).toMatchObject({ code: 'RECEIPT_DONE' });
  });

  it('bill bisa ditampilkan di layar bila printer gagal, dan tetap tercatat', async () => {
    const printer = new SimPrinter();
    const c = await setup({ printer });
    await login(c, 'budi');
    must(await c.engine.openShift(0));
    const o = must(await c.engine.createOrder('TAKE_AWAY'));
    must(await c.engine.addItem(o.id, 'teh'));
    printer.paper = false;
    expect(await c.engine.printBill(o.id)).toMatchObject({ code: 'PRINT_FAILED' });
    must(await c.engine.printBill(o.id, { onScreen: true }));
    expect(c.engine.getOrder(o.id)!.state.billPrinted).toBe(true);
  });

  it('status printer dicatat hanya saat berubah; klaim kertas habis dicatat sebagai event terpisah', async () => {
    const printer = new SimPrinter();
    const c = await setup({ printer });
    await login(c, 'budi');
    await c.engine.pollPrinter();
    await c.engine.pollPrinter();
    printer.paper = false;
    await c.engine.pollPrinter();
    must(await c.engine.setPaperClaim(true));
    must(await c.engine.setPaperClaim(true)); // tidak menggandakan event
    const types = await c.types();
    expect(types.filter((t) => t === 'printer.status')).toHaveLength(2);
    expect(types.filter((t) => t === 'printer.paper_claim')).toHaveLength(1);
  });

  it('printer tanpa status kertas: tidak ada event printer.status', async () => {
    const c = await setup({ printer: new SimPrinter({ reportsPaperStatus: false }) });
    expect(await c.engine.pollPrinter()).toBeNull();
    expect(await c.types()).toEqual([]);
  });
});

describe('ketahanan', () => {
  it('menyimpan semuanya dan melanjutkan rantai setelah aplikasi dimulai ulang', async () => {
    const c = await setup();
    await login(c, 'budi');
    must(await c.engine.openShift(5_000));
    const id = await billedOrder(c);

    // "restart": engine dan recorder baru di atas penyimpanan yang sama
    const config = await demoConfig();
    const recorder = new Recorder({ deviceId: config.deviceId, outletId: config.outletId, store: c.store, now: () => T0 + 5_000 });
    const engine = new PosEngine({ config, recorder, store: c.store, printer: new SimPrinter(), now: () => T0 + 5_000 });
    await engine.init();
    await engine.login('budi', c.pins.budi);

    expect(engine.currentShift()).toMatchObject({ openingCash: 5_000 });
    expect(engine.getOrder(id)!.state.billPrinted).toBe(true);
    must(await engine.pay(id, { method: 'CASH', tendered: 50_000 }));

    const events: PosEvent[] = await recorder.pending();
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(verifyChain(events)).toEqual([]);
  });

  it('pencatatan serentak tidak merusak urutan', async () => {
    const c = await setup();
    await Promise.all(Array.from({ length: 20 }, () => c.engine.heartbeat()));
    const events = await c.events();
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(verifyChain(events)).toEqual([]);
  });
});

describe('makan karyawan: kuota dan persetujuan', () => {
  let c: Ctx;
  beforeEach(async () => {
    c = await setup();
    await login(c, 'budi');
    must(await c.engine.openShift(0));
  });
  const orderCount = () => c.engine.listOrders().length;
  const createdEvents = async () => (await c.events()).filter((e) => e.type === 'order.created');
  const approver = (id: keyof Ctx['pins'], pin?: string) => ({ userId: id, pin: pin ?? c.pins[id] });

  it('makan pertama hari ini untuk orang lain lolos tanpa persetujuan, dan event tidak membawa approver', async () => {
    const o = must(await c.engine.createOrder('EMPLOYEE', { employeeId: 'sari' }));
    expect(o.type).toBe('EMPLOYEE');
    const ev = (await createdEvents())[0]!;
    expect(ev.type === 'order.created' && ev.payload).toEqual({ orderId: o.id, orderType: 'EMPLOYEE', employeeId: 'sari' });
  });

  it('makan kedua penerima yang sama ditolak (MEAL_APPROVAL_REQUIRED) dan tidak ada yang tercatat', async () => {
    must(await c.engine.createOrder('EMPLOYEE', { employeeId: 'sari' }));
    const before = { orders: orderCount(), events: (await c.events()).length };
    const r = await c.engine.createOrder('EMPLOYEE', { employeeId: 'sari' });
    expect(r).toMatchObject({ ok: false, code: 'MEAL_APPROVAL_REQUIRED' });
    expect(orderCount()).toBe(before.orders);
    expect((await c.events()).length).toBe(before.events);
  });

  it('dengan PIN supervisor yang benar order dibuat dan approverId tercatat di event', async () => {
    must(await c.engine.createOrder('EMPLOYEE', { employeeId: 'sari' }));
    const o = must(await c.engine.createOrder('EMPLOYEE', { employeeId: 'sari', approver: approver('hendra') }));
    const ev = (await createdEvents()).find((e) => e.type === 'order.created' && e.payload.orderId === o.id)!;
    expect(ev.type === 'order.created' && ev.payload.approverId).toBe('hendra');
  });

  it('PIN approver salah ditolak; approver yang adalah pembuat atau penerima juga ditolak', async () => {
    must(await c.engine.createOrder('EMPLOYEE', { employeeId: 'sari' }));
    const second = (a: { userId: string; pin: string }) => c.engine.createOrder('EMPLOYEE', { employeeId: 'sari', approver: a });
    expect(await second(approver('hendra', '0000'))).toMatchObject({ ok: false, code: 'PIN_WRONG' });
    expect(await second(approver('sari'))).toMatchObject({ ok: false, code: 'RECIPIENT_APPROVAL' }); // penerima tidak boleh menyetujui makannya sendiri
    expect(await second(approver('budi'))).toMatchObject({ ok: false, code: 'SELF_APPROVAL' });
    expect(orderCount()).toBe(1);
    // penerima seorang supervisor tidak boleh menyetujui makannya sendiri
    must(await c.engine.createOrder('EMPLOYEE', { employeeId: 'hendra' }));
    expect(await c.engine.createOrder('EMPLOYEE', { employeeId: 'hendra', approver: approver('hendra') })).toMatchObject({ ok: false, code: 'RECIPIENT_APPROVAL' });
    expect((await c.engine.createOrder('EMPLOYEE', { employeeId: 'hendra', approver: approver('rina') })).ok).toBe(true);
  });

  it('kasir yang membuat makan untuk dirinya sendiri perlu persetujuan, walau baru pertama', async () => {
    expect(await c.engine.createOrder('EMPLOYEE', { employeeId: 'budi' })).toMatchObject({ ok: false, code: 'MEAL_APPROVAL_REQUIRED' });
    const o = must(await c.engine.createOrder('EMPLOYEE', { employeeId: 'budi', approver: approver('hendra') }));
    expect(o.employeeId).toBe('budi');
  });

  it('penerima berbeda punya kuota sendiri-sendiri, dan order biasa tidak terpengaruh', async () => {
    must(await c.engine.createOrder('EMPLOYEE', { employeeId: 'sari' }));
    must(await c.engine.createOrder('EMPLOYEE', { employeeId: 'hendra' }));
    must(await c.engine.createOrder('EMPLOYEE', { employeeId: 'rina' }));
    must(await c.engine.createOrder('TAKE_AWAY'));
  });

  it('order karyawan yang di-void mengembalikan kuota hari itu', async () => {
    const first = must(await c.engine.createOrder('EMPLOYEE', { employeeId: 'sari' }));
    expect(await c.engine.createOrder('EMPLOYEE', { employeeId: 'sari' })).toMatchObject({ ok: false });
    must(await c.engine.voidOrder(first.id, 'WRONG_ORDER', [])); // masih draft: tanpa persetujuan
    must(await c.engine.createOrder('EMPLOYEE', { employeeId: 'sari' }));
  });

  it('besok kuota kembali', async () => {
    must(await c.engine.createOrder('EMPLOYEE', { employeeId: 'sari' }));
    c.tick(30 * 3_600_000);
    must(await c.engine.createOrder('EMPLOYEE', { employeeId: 'sari' }));
  });

  it('kuota mengikuti kebijakan outlet', async () => {
    const config = await demoConfig();
    c.engine.setConfig({ ...config, policy: { ...DEFAULT_POLICY, employeeMealQuota: 2 } });
    must(await c.engine.createOrder('EMPLOYEE', { employeeId: 'sari' }));
    must(await c.engine.createOrder('EMPLOYEE', { employeeId: 'sari' }));
    expect(await c.engine.createOrder('EMPLOYEE', { employeeId: 'sari' })).toMatchObject({ ok: false, code: 'MEAL_APPROVAL_REQUIRED' });
  });

  it('tetap mewajibkan memilih karyawan penerima', async () => {
    expect(await c.engine.createOrder('EMPLOYEE')).toMatchObject({ ok: false, code: 'EMPLOYEE_REQUIRED' });
  });
});
