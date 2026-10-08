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

describe('item pesanan di event', () => {
  let c: Ctx;
  beforeEach(async () => {
    c = await setup();
    await login(c, 'budi');
    must(await c.engine.openShift(100_000));
  });

  it('bill.printed membawa seluruh item dengan nama dan harga saat kejadian', async () => {
    const id = await billedOrder(c);
    const bill = (await c.events()).find((e) => e.type === 'bill.printed' && e.payload.orderId === id);
    expect(bill?.type === 'bill.printed' && bill.payload).toMatchObject({
      total: 44_000 + 4_400,
      items: [{ itemId: 'kopi-susu', name: 'Kopi Susu', qty: 2, unitPrice: 22_000 }],
    });
  });

  it('order.sent_to_kitchen hanya membawa selisih: kiriman kedua memuat item baru dan tambahan jumlah', async () => {
    const o = must(await c.engine.createOrder('DINE_IN', { tableNo: '3' }));
    must(await c.engine.addItem(o.id, 'kopi-susu', 1));
    must(await c.engine.sendToKitchen(o.id));
    must(await c.engine.addItem(o.id, 'kopi-susu', 2));
    must(await c.engine.addItem(o.id, 'latte', 1));
    must(await c.engine.sendToKitchen(o.id));
    const sent = (await c.events()).filter((e) => e.type === 'order.sent_to_kitchen');
    expect(sent.map((e) => (e.type === 'order.sent_to_kitchen' ? e.payload.items : null))).toEqual([
      [{ itemId: 'kopi-susu', name: 'Kopi Susu', qty: 1, unitPrice: 22_000 }],
      [
        { itemId: 'kopi-susu', name: 'Kopi Susu', qty: 2, unitPrice: 22_000 },
        { itemId: 'latte', name: 'Latte', qty: 1, unitPrice: 26_000 },
      ],
    ]);
  });

  it('rantai hash tetap utuh dengan payload yang lebih besar', async () => {
    await billedOrder(c);
    expect(verifyChain(await c.events())).toEqual([]);
  });
});

describe('varian dan tambahan menu', () => {
  let c: Ctx;
  beforeEach(async () => {
    c = await setup();
    await login(c, 'budi');
    must(await c.engine.openShift(100_000));
  });
  const newOrder = async () => must(await c.engine.createOrder('TAKE_AWAY')).id;

  it('menu dengan varian wajib ditolak tanpa pilihan, dan tidak ada yang tercatat di order', async () => {
    const id = await newOrder();
    expect(await c.engine.addItem(id, 'matcha', 1)).toMatchObject({ ok: false, code: 'OPTION_REQUIRED', message: 'Pilih Ukuran.' });
    expect(c.engine.getOrder(id)!.items).toEqual([]);
  });

  it('harga satuan = harga menu + harga opsi: matcha Large + Boba + Oat = 28.000 + 6.000 + 6.000 + 8.000 = 48.000', async () => {
    const id = await newOrder();
    const o = must(await c.engine.addItem(id, 'matcha', 2, { options: ['large', 'boba', 'oat'] }));
    expect(o.items[0]).toMatchObject({ itemId: 'matcha', qty: 2, unitPrice: 48_000 });
    expect(c.engine.totals(o).subtotal).toBe(96_000);
  });

  it('batas pilihan: dua ukuran ditolak, tiga topping ditolak, opsi asing ditolak, opsi ganda ditolak', async () => {
    const id = await newOrder();
    expect(await c.engine.addItem(id, 'matcha', 1, { options: ['regular', 'large'] })).toMatchObject({ code: 'OPTION_TOO_MANY' });
    expect(await c.engine.addItem(id, 'nasi-goreng', 1, { options: ['sedang', 'telur', 'sate', 'telur'] })).toMatchObject({ code: 'OPTION_UNKNOWN' });
    expect(await c.engine.addItem(id, 'matcha', 1, { options: ['regular', 'telur'] })).toMatchObject({ code: 'OPTION_UNKNOWN' });
    expect(await c.engine.addItem(id, 'kopi-susu', 1, { options: ['large'] })).toMatchObject({ code: 'OPTION_UNKNOWN' });
    expect(c.engine.getOrder(id)!.items).toEqual([]);
  });

  it('pilihan yang sama (urutan berbeda) digabung; pilihan berbeda atau catatan berbeda menjadi baris baru', async () => {
    const id = await newOrder();
    must(await c.engine.addItem(id, 'matcha', 1, { options: ['large', 'boba'] }));
    must(await c.engine.addItem(id, 'matcha', 1, { options: ['boba', 'large'] }));
    must(await c.engine.addItem(id, 'matcha', 1, { options: ['regular'] }));
    must(await c.engine.addItem(id, 'matcha', 1, { options: ['regular'], note: 'es sedikit' }));
    must(await c.engine.addItem(id, 'kopi-susu', 1));
    must(await c.engine.addItem(id, 'kopi-susu', 1));
    const items = c.engine.getOrder(id)!.items;
    expect(items.map((l) => [l.lineId, l.qty])).toEqual([['matcha', 2], ['matcha#2', 1], ['matcha#3', 1], ['kopi-susu', 2]]);
  });

  it('setQty memakai lineId: mengubah satu baris tidak menyentuh baris lain dari menu yang sama', async () => {
    const id = await newOrder();
    must(await c.engine.addItem(id, 'matcha', 1, { options: ['regular'] }));
    must(await c.engine.addItem(id, 'matcha', 1, { options: ['large'] }));
    must(await c.engine.setQty(id, 'matcha#2', 3));
    expect(c.engine.getOrder(id)!.items.map((l) => [l.lineId, l.qty])).toEqual([['matcha', 1], ['matcha#2', 3]]);
    must(await c.engine.setQty(id, 'matcha', 0));
    expect(c.engine.getOrder(id)!.items.map((l) => l.lineId)).toEqual(['matcha#2']);
  });

  it('order lama tanpa lineId tetap bisa diubah memakai itemId', async () => {
    const id = await newOrder();
    must(await c.engine.addItem(id, 'kopi-susu', 1));
    delete c.engine.getOrder(id)!.items[0]!.lineId; // bentuk tersimpan sebelum varian ada
    must(await c.engine.setQty(id, 'kopi-susu', 4));
    expect(c.engine.getOrder(id)!.items[0]!.qty).toBe(4);
  });

  it('catatan: dipangkas, dibatasi 140 karakter, bisa diubah sebelum dikirim ke dapur, tidak sesudahnya', async () => {
    const id = await newOrder();
    expect(await c.engine.addItem(id, 'kopi-susu', 1, { note: 'x'.repeat(141) })).toMatchObject({ code: 'NOTE_TOO_LONG' });
    must(await c.engine.addItem(id, 'kopi-susu', 1, { note: '  tanpa gula  ' }));
    expect(c.engine.getOrder(id)!.items[0]!.note).toBe('tanpa gula');
    must(await c.engine.setNote(id, 'kopi-susu', 'gula sedikit'));
    expect(c.engine.getOrder(id)!.items[0]!.note).toBe('gula sedikit');
    must(await c.engine.sendToKitchen(id));
    expect(await c.engine.setNote(id, 'kopi-susu', 'lain')).toMatchObject({ code: 'ITEM_SENT' });
  });

  it('mengosongkan catatan sampai sama dengan baris lain ditolak (tidak boleh ada dua baris kembar)', async () => {
    const id = await newOrder();
    must(await c.engine.addItem(id, 'kopi-susu', 1));
    must(await c.engine.addItem(id, 'kopi-susu', 1, { note: 'panas' }));
    expect(await c.engine.setNote(id, 'kopi-susu#2', '')).toMatchObject({ code: 'LINE_DUPLICATE' });
  });

  it('event membawa opsi dan catatan; unitPrice di event sudah termasuk harga opsi', async () => {
    const id = await newOrder();
    must(await c.engine.addItem(id, 'nasi-goreng', 2, { options: ['pedas', 'telur'], note: 'tanpa bawang' }));
    must(await c.engine.sendToKitchen(id));
    must(await c.engine.printBill(id));
    const expected = {
      itemId: 'nasi-goreng', name: 'Nasi Goreng', qty: 2, unitPrice: 43_000, note: 'tanpa bawang',
      options: [{ group: 'Level pedas', name: 'Pedas', price: 0 }, { group: 'Tambahan', name: 'Telur', price: 5_000 }],
    };
    const evs = await c.events();
    const sent = evs.find((e) => e.type === 'order.sent_to_kitchen');
    const bill = evs.find((e) => e.type === 'bill.printed');
    expect(sent?.type === 'order.sent_to_kitchen' && sent.payload.items).toEqual([expected]);
    expect(bill?.type === 'bill.printed' && bill.payload.items).toEqual([expected]);
    expect(bill?.type === 'bill.printed' && bill.payload.total).toBe(Math.round(86_000 * 1.1));
  });

  it('tiket dapur dan bill menampilkan opsi; catatan hanya di tiket dapur', async () => {
    const id = await newOrder();
    must(await c.engine.addItem(id, 'matcha', 1, { options: ['large', 'oat'], note: 'es sedikit' }));
    must(await c.engine.sendToKitchen(id));
    must(await c.engine.printBill(id));
    const [ticket, bill] = c.printer.printed;
    expect(ticket).toContain('1x Matcha Latte (Large, Oat Milk)');
    expect(ticket).toContain('* es sedikit');
    expect(bill).toContain('1x Matcha Latte (Large, Oat Milk)');
    expect(bill).not.toContain('es sedikit');
    expect(bill).toContain('Rp 42.000');
  });

  it('item yang sudah dikirim: menambah pilihan yang sama hanya mengirim selisihnya', async () => {
    const id = await newOrder();
    must(await c.engine.addItem(id, 'matcha', 1, { options: ['large'] }));
    must(await c.engine.sendToKitchen(id));
    must(await c.engine.addItem(id, 'matcha', 2, { options: ['large'] }));
    must(await c.engine.sendToKitchen(id));
    const sent = (await c.events()).filter((e) => e.type === 'order.sent_to_kitchen');
    expect(sent.map((e) => (e.type === 'order.sent_to_kitchen' ? e.payload.items?.[0]?.qty : 0))).toEqual([1, 2]);
  });
});

describe('pindah meja, pisah bill, gabung order, bayar sebagian', () => {
  let c: Ctx;
  beforeEach(async () => {
    c = await setup();
    await login(c, 'budi');
    must(await c.engine.openShift(100_000));
  });
  const dineIn = async (table = '4') => must(await c.engine.createOrder('DINE_IN', { tableNo: table })).id;
  const takeAway = async () => must(await c.engine.createOrder('TAKE_AWAY')).id;
  const evs = async <T extends PosEvent['type']>(type: T) => (await c.events()).filter((e) => e.type === type) as Extract<PosEvent, { type: T }>[];
  const total = (id: string) => c.engine.totals(c.engine.getOrder(id)!).total;

  describe('pindah meja', () => {
    it('mengubah meja dan mencatat event dengan meja asal dan tujuan', async () => {
      const id = await dineIn('4');
      must(await c.engine.moveTable(id, ' 12 '));
      expect(c.engine.getOrder(id)!.tableNo).toBe('12');
      expect((await evs('order.table_changed')).map((e) => e.payload)).toEqual([{ orderId: id, from: '4', to: '12' }]);
    });

    it('menolak: take-away, meja sama, meja kosong atau terlalu panjang, order yang sudah lunas', async () => {
      expect(await c.engine.moveTable(await takeAway(), '3')).toMatchObject({ code: 'NOT_DINE_IN' });
      const id = await dineIn('4');
      expect(await c.engine.moveTable(id, '4')).toMatchObject({ code: 'TABLE_SAME' });
      expect(await c.engine.moveTable(id, '  ')).toMatchObject({ code: 'TABLE_INVALID' });
      expect(await c.engine.moveTable(id, '12345678901')).toMatchObject({ code: 'TABLE_INVALID' });
      must(await c.engine.addItem(id, 'kopi-susu', 1));
      must(await c.engine.printBill(id));
      must(await c.engine.pay(id, { method: 'CASH' }));
      expect(await c.engine.moveTable(id, '9')).toMatchObject({ code: 'ORDER_LOCKED' });
      expect((await evs('order.table_changed'))).toHaveLength(0);
    });
  });

  describe('pisah bill', () => {
    async function threeKopiOneLatte() {
      const id = await dineIn('5');
      must(await c.engine.addItem(id, 'kopi-susu', 3));
      must(await c.engine.addItem(id, 'latte', 1));
      return id;
    }

    it('memindahkan 1 kopi ke bill baru: jumlah dan nilai terbagi, jumlah keduanya sama dengan semula', async () => {
      const id = await threeKopiOneLatte();
      const before = total(id); // 3×22.000 + 26.000 = 92.000 + PBJT 9.200
      expect(before).toBe(101_200);
      const dest = must(await c.engine.splitOrder(id, [{ lineId: 'kopi-susu', qty: 1 }]));
      const src = c.engine.getOrder(id)!;
      expect(src.items.map((l) => [l.itemId, l.qty])).toEqual([['kopi-susu', 2], ['latte', 1]]);
      expect(dest.items.map((l) => [l.itemId, l.qty, l.sentQty])).toEqual([['kopi-susu', 1, 0]]);
      expect(dest).toMatchObject({ type: 'DINE_IN', tableNo: '5', splitFrom: id, state: { status: 'DRAFT' } });
      expect(total(id)).toBe(Math.round(70_000 * 1.1));
      expect(total(dest.id)).toBe(Math.round(22_000 * 1.1));
      expect(total(id) + total(dest.id)).toBe(before); // 77.000 + 24.200
    });

    it('event: order baru dibuat lalu items_moved SPLIT dengan item yang berpindah', async () => {
      const id = await threeKopiOneLatte();
      const dest = must(await c.engine.splitOrder(id, [{ lineId: 'kopi-susu', qty: 2 }]));
      const types = (await c.types()).slice(-2);
      expect(types).toEqual(['order.created', 'order.items_moved']);
      const [m] = await evs('order.items_moved');
      expect(m!.payload).toEqual({
        fromOrderId: id, toOrderId: dest.id, kind: 'SPLIT', sent: false,
        items: [{ itemId: 'kopi-susu', name: 'Kopi Susu', qty: 2, unitPrice: 22_000 }],
      });
      expect(verifyChain(await c.events())).toEqual([]);
    });

    it('item yang sudah dikirim ke dapur tetap tercatat terkirim di bill baru dan tidak dikirim dua kali', async () => {
      const id = await dineIn();
      must(await c.engine.addItem(id, 'kopi-susu', 2));
      must(await c.engine.sendToKitchen(id));
      must(await c.engine.setKitchenStatus(id, 'COOKING'));
      const dest = must(await c.engine.splitOrder(id, [{ lineId: 'kopi-susu', qty: 1 }]));
      expect(dest.items[0]).toMatchObject({ qty: 1, sentQty: 1 });
      expect(dest.state).toMatchObject({ status: 'SENT', kitchen: 'COOKING' });
      expect(c.engine.getOrder(id)!.items[0]).toMatchObject({ qty: 1, sentQty: 1 });
      expect(await c.engine.sendToKitchen(dest.id)).toMatchObject({ code: 'NOTHING_TO_SEND' });
      must(await c.engine.addItem(id, 'kopi-susu', 1)); // tambahan baru di bill asal: hanya itu yang dikirim
      must(await c.engine.sendToKitchen(id));
      const sent = await evs('order.sent_to_kitchen');
      expect(sent.map((e) => e.payload.items?.map((l) => l.qty))).toEqual([[2], [1]]);
    });

    it('campuran terkirim dan belum: yang belum terkirim dipindah lebih dulu, yang terkirim tetap di bill asal', async () => {
      const id = await dineIn();
      must(await c.engine.addItem(id, 'kopi-susu', 1));
      must(await c.engine.sendToKitchen(id)); // 1 terkirim
      must(await c.engine.addItem(id, 'kopi-susu', 2)); // total 3, 1 terkirim, 2 belum
      const dest = must(await c.engine.splitOrder(id, [{ lineId: 'kopi-susu', qty: 2 }]));
      expect(dest.items[0]).toMatchObject({ qty: 2, sentQty: 0 });
      expect(c.engine.getOrder(id)!.items[0]).toMatchObject({ qty: 1, sentQty: 1 });
    });

    it('bill asal kembali "draft" bila semua item terkirimnya sudah pindah', async () => {
      const id = await dineIn();
      must(await c.engine.addItem(id, 'kopi-susu', 1));
      must(await c.engine.sendToKitchen(id));
      must(await c.engine.addItem(id, 'latte', 1));
      expect(c.engine.getOrder(id)!.state.status).toBe('SENT');
      must(await c.engine.splitOrder(id, [{ lineId: 'kopi-susu', qty: 1 }]));
      expect(c.engine.getOrder(id)!.state.status).toBe('DRAFT');
    });

    it('opsi dan catatan ikut pindah, dan baris yang sama di bill baru digabung', async () => {
      const id = await dineIn();
      must(await c.engine.addItem(id, 'matcha', 3, { options: ['large'], note: 'es sedikit' }));
      const dest = must(await c.engine.splitOrder(id, [{ lineId: 'matcha', qty: 2 }]));
      expect(dest.items).toHaveLength(1);
      expect(dest.items[0]).toMatchObject({ qty: 2, unitPrice: 34_000, note: 'es sedikit', options: [{ name: 'Large' }] });
    });

    it('dua bill dibayar terpisah dengan metode berbeda; item di event tagihan masing-masing sesuai', async () => {
      const id = await threeKopiOneLatte();
      const dest = must(await c.engine.splitOrder(id, [{ lineId: 'latte', qty: 1 }]));
      must(await c.engine.printBill(dest.id));
      must(await c.engine.pay(dest.id, { method: 'QRIS', tid: '12345678' }));
      must(await c.engine.printBill(id));
      must(await c.engine.pay(id, { method: 'CASH', tendered: 100_000 }));
      expect([c.engine.getOrder(id)!.state.status, c.engine.getOrder(dest.id)!.state.status]).toEqual(['PAID', 'PAID']);
      const bills = await evs('bill.printed');
      const byOrder = Object.fromEntries(bills.map((b) => [b.payload.orderId, b.payload.items?.map((l) => `${l.qty}×${l.itemId}`)]));
      expect(byOrder).toEqual({ [dest.id]: ['1×latte'], [id]: ['3×kopi-susu'] });
    });

    it('ditolak: tidak memilih apa pun, jumlah berlebih, baris tidak ada, baris ganda, semua item, order karyawan, sudah ditagih', async () => {
      const id = await threeKopiOneLatte();
      expect(await c.engine.splitOrder(id, [])).toMatchObject({ code: 'SPLIT_EMPTY' });
      expect(await c.engine.splitOrder(id, [{ lineId: 'kopi-susu', qty: 4 }])).toMatchObject({ code: 'QTY_INVALID' });
      expect(await c.engine.splitOrder(id, [{ lineId: 'kopi-susu', qty: 0 }])).toMatchObject({ code: 'QTY_INVALID' });
      expect(await c.engine.splitOrder(id, [{ lineId: 'tidak-ada', qty: 1 }])).toMatchObject({ code: 'ITEM_NOT_FOUND' });
      expect(await c.engine.splitOrder(id, [{ lineId: 'latte', qty: 1 }, { lineId: 'latte', qty: 1 }])).toMatchObject({ code: 'SPLIT_INVALID' });
      expect(await c.engine.splitOrder(id, [{ lineId: 'kopi-susu', qty: 3 }, { lineId: 'latte', qty: 1 }])).toMatchObject({ code: 'SPLIT_ALL' });
      must(await c.engine.printBill(id));
      expect(await c.engine.splitOrder(id, [{ lineId: 'latte', qty: 1 }])).toMatchObject({ code: 'SPLIT_LOCKED' });
      const meal = must(await c.engine.createOrder('EMPLOYEE', { employeeId: 'sari' }));
      must(await c.engine.addItem(meal.id, 'kopi-susu', 2));
      expect(await c.engine.splitOrder(meal.id, [{ lineId: 'kopi-susu', qty: 1 }])).toMatchObject({ code: 'SPLIT_EMPLOYEE' });
      expect(await evs('order.items_moved')).toHaveLength(0);
      expect(c.engine.listOrders()).toHaveLength(2); // tidak ada order baru yang tertinggal dari percobaan gagal
    });
  });

  describe('gabung order', () => {
    it('semua item order asal pindah, baris yang sama dijumlahkan, order asal MERGED dan kosong', async () => {
      const a = await takeAway();
      const b = await takeAway();
      must(await c.engine.addItem(a, 'kopi-susu', 1));
      must(await c.engine.addItem(b, 'kopi-susu', 2));
      must(await c.engine.addItem(b, 'latte', 1));
      const into = must(await c.engine.mergeOrders(a, b));
      expect(into.items.map((l) => [l.itemId, l.qty])).toEqual([['kopi-susu', 3], ['latte', 1]]);
      const src = c.engine.getOrder(b)!;
      expect(src).toMatchObject({ items: [], mergedInto: a, state: { status: 'MERGED' } });
      expect(total(a)).toBe(Math.round(92_000 * 1.1));
      const [m] = await evs('order.items_moved');
      expect(m!.payload).toMatchObject({ fromOrderId: b, toOrderId: a, kind: 'MERGE', sent: false });
      expect(m!.payload.items.map((l) => [l.itemId, l.qty])).toEqual([['kopi-susu', 2], ['latte', 1]]);
    });

    it('jumlah terkirim ikut dijumlahkan: yang sudah dikirim di order asal tidak dikirim ulang', async () => {
      const a = await dineIn('1');
      const b = await dineIn('2');
      must(await c.engine.addItem(a, 'kopi-susu', 1));
      must(await c.engine.sendToKitchen(a));
      must(await c.engine.addItem(b, 'kopi-susu', 2));
      must(await c.engine.sendToKitchen(b));
      const into = must(await c.engine.mergeOrders(a, b));
      expect(into.items[0]).toMatchObject({ qty: 3, sentQty: 3 });
      expect(await c.engine.sendToKitchen(a)).toMatchObject({ code: 'NOTHING_TO_SEND' });
    });

    it('status dapur mengikuti yang paling maju: order asal sudah disajikan → void order gabungan wajib persetujuan', async () => {
      const a = await takeAway();
      const b = await takeAway();
      must(await c.engine.addItem(a, 'latte', 1)); // draft: void tanpa persetujuan
      must(await c.engine.addItem(b, 'kopi-susu', 1));
      must(await c.engine.sendToKitchen(b));
      must(await c.engine.setKitchenStatus(b, 'SERVED'));
      const into = must(await c.engine.mergeOrders(a, b));
      expect(into.state).toMatchObject({ status: 'SENT', kitchen: 'SERVED' });
      expect(await c.engine.voidOrder(a, 'WRONG_ORDER', [])).toMatchObject({ ok: false, code: 'NOT_ENOUGH_APPROVERS' });
    });

    it('kedua order punya status dapur: yang paling maju menang, ke arah mana pun penggabungannya', async () => {
      for (const [into, from, want] of [['COOKING', 'SERVED', 'SERVED'], ['SERVED', 'COOKING', 'SERVED'], ['READY', 'COOKING', 'READY']] as const) {
        const a = await takeAway();
        const b = await takeAway();
        for (const [id, st] of [[a, into], [b, from]] as const) {
          must(await c.engine.addItem(id, 'kopi-susu', 1));
          must(await c.engine.sendToKitchen(id));
          must(await c.engine.setKitchenStatus(id, st));
        }
        const merged = must(await c.engine.mergeOrders(a, b));
        expect(merged.state.kitchen, `${into}+${from}`).toBe(want);
        expect(merged.kitchen).toBe(want);
      }
    });

    it('order gabungan dibayar; shift bisa ditutup karena order asal sudah MERGED', async () => {
      const a = await takeAway();
      const b = await takeAway();
      must(await c.engine.addItem(a, 'kopi-susu', 1));
      must(await c.engine.addItem(b, 'kopi-susu', 1));
      must(await c.engine.mergeOrders(a, b));
      expect(await c.engine.closeShift(0)).toMatchObject({ code: 'OPEN_ORDERS' });
      must(await c.engine.printBill(a));
      must(await c.engine.pay(a, { method: 'CASH' }));
      must(await c.engine.closeShift(100_000 + 48_400));
    });

    it('ditolak: order sama, beda jenis, karyawan, sudah ditagih, asal kosong; tidak ada event yang tercatat', async () => {
      const a = await takeAway();
      const d = await dineIn();
      const b = await takeAway();
      must(await c.engine.addItem(a, 'kopi-susu', 1));
      must(await c.engine.addItem(d, 'kopi-susu', 1));
      expect(await c.engine.mergeOrders(a, a)).toMatchObject({ code: 'MERGE_SAME' });
      expect(await c.engine.mergeOrders(a, d)).toMatchObject({ code: 'MERGE_TYPE' });
      expect(await c.engine.mergeOrders(a, b)).toMatchObject({ code: 'EMPTY_ORDER' });
      const meal = must(await c.engine.createOrder('EMPLOYEE', { employeeId: 'sari' }));
      must(await c.engine.addItem(meal.id, 'kopi-susu', 1));
      expect(await c.engine.mergeOrders(a, meal.id)).toMatchObject({ code: 'MERGE_EMPLOYEE' });
      must(await c.engine.addItem(b, 'latte', 1));
      must(await c.engine.printBill(b));
      expect(await c.engine.mergeOrders(a, b)).toMatchObject({ code: 'MERGE_LOCKED' });
      expect(await c.engine.mergeOrders(b, a)).toMatchObject({ code: 'MERGE_LOCKED' });
      expect(await evs('order.items_moved')).toHaveLength(0);
    });
  });

  describe('bayar sebagian', () => {
    it('sebagian tunai lalu sisanya QRIS: status tetap ditagih sampai lunas, penerimaan terbagi per metode', async () => {
      const id = await takeAway();
      must(await c.engine.addItem(id, 'kopi-susu', 2)); // 44.000 + 4.400 = 48.400
      must(await c.engine.printBill(id));
      const first = must(await c.engine.pay(id, { method: 'CASH', amount: 20_000, tendered: 50_000 }));
      expect(first.change).toBe(30_000);
      expect(c.engine.getOrder(id)!.state.status).toBe('BILLED');
      expect(c.engine.outstanding(c.engine.getOrder(id)!)).toBe(28_400);
      expect(await c.engine.pay(id, { method: 'QRIS', amount: 30_000 })).toMatchObject({ code: 'AMOUNT_INVALID' });
      must(await c.engine.pay(id, { method: 'QRIS', amount: 28_400 }));
      expect(c.engine.getOrder(id)!.state.status).toBe('PAID');
      expect(c.engine.getOrder(id)!.payments.map((p) => [p.method, p.amount])).toEqual([['CASH', 20_000], ['QRIS', 28_400]]);
    });
  });
});

