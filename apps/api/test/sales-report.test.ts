import { describe, expect, it } from 'vitest';
import type { EventBody } from '@pos/events';
import { Sim } from '@pos/sim';
import { addDays, buildSalesReport, localDate, startOfLocalDay, DAY_MS } from '../src/sales-report';

const DAY = '2026-10-01';
const NOW = Date.parse('2026-10-02T09:00:00+07:00');

function report(s: Sim, opts: { from?: string; to?: string; off?: number; now?: number } = {}) {
  const off = opts.off ?? 420;
  const from = opts.from ?? DAY;
  const to = opts.to ?? DAY;
  return buildSalesReport({
    events: s.events, from, to, utcOffsetMinutes: off, now: opts.now ?? NOW,
    fromMs: startOfLocalDay(from, off), toMs: startOfLocalDay(to, off) + DAY_MS,
  });
}

const created = (s: Sim, id: string, at: string | number, actor = 'budi', type: 'TAKE_AWAY' | 'EMPLOYEE' = 'TAKE_AWAY', employeeId?: string) =>
  s.pos({ type: 'order.created', payload: { orderId: id, orderType: type, ...(employeeId ? { employeeId } : {}) } }, at, actor);
const pay = (s: Sim, id: string, at: string | number, amount: number, method: 'CASH' | 'QRIS' = 'CASH', actor = 'budi') =>
  s.pos({ type: 'payment.received', payload: { orderId: id, method, amount, ...(method === 'QRIS' ? { tid: '12345678' } : {}) } }, at, actor);
const voidOrder = (s: Sim, id: string, at: string | number, amount: number, actor = 'budi') =>
  s.pos({ type: 'void.approved', payload: { orderId: id, reasonCode: 'CUSTOMER_CANCEL', approverIds: ['hendra'], amount } } as EventBody, at, actor);

/** Satu hari dengan angka yang dihitung manual (lihat komentar di tiap tes). */
function busyDay(): Sim {
  const s = new Sim('o1', DAY);
  created(s, 'o1', '10:00:00'); pay(s, 'o1', '10:05:00', 50_000);
  s.pos({ type: 'discount.applied', payload: { orderId: 'o1', kind: 'MANUAL', amount: 5_000, percent: 10, verified: false } }, '10:02:00', 'budi');
  created(s, 'o2', '10:30:00', 'sari'); pay(s, 'o2', '10:40:00', 30_000, 'QRIS', 'sari');
  created(s, 'o3', '19:20:00'); pay(s, 'o3', '19:30:00', 20_000);
  s.pos({ type: 'refund.created', payload: { refundId: 'o3-R1', originalOrderId: 'o3', amount: 10_000, method: 'CASH', approverId: 'hendra' } }, '19:40:00', 'budi');
  created(s, 'o4', '11:50:00', 'sari'); pay(s, 'o4', '12:00:00', 40_000, 'CASH', 'sari'); voidOrder(s, 'o4', '12:10:00', 40_000, 'sari');
  created(s, 'o5', '12:50:00'); voidOrder(s, 'o5', '13:00:00', 15_000, 'budi');
  created(s, 'o6', '11:00:00', 'budi', 'EMPLOYEE', 'andi');
  s.pos({ type: 'cash.counted', payload: { shiftId: 'S1', counted: 495_000, expected: 500_000 } }, '21:00:00', 'budi');
  return s;
}

describe('laporan penjualan: satu hari', () => {
  const r = report(busyDay());

  it('total: gross 100.000 (o4 yang di-void tidak dihitung), refund 10.000, bersih 90.000, 3 order', () => {
    expect(r.totals).toMatchObject({ gross: 100_000, refunds: 10_000, net: 90_000, orders: 3, avgOrder: 33_333 });
  });

  it('void: 2 (55.000), 1 di antaranya setelah dibayar (40.000); diskon 1 (5.000); makan karyawan 1', () => {
    expect(r.totals.voids).toEqual({ count: 2, amount: 55_000, afterPayment: { count: 1, amount: 40_000 } });
    expect(r.totals.discount).toEqual({ count: 1, amount: 5_000 });
    expect(r.totals.employeeMeals).toBe(1);
  });

  it('metode bayar: tunai 70.000 − refund tunai 10.000 = 60.000 dari 2 pembayaran, QRIS 30.000', () => {
    expect(r.byMethod).toEqual([
      { method: 'CASH', payments: 2, amount: 60_000 },
      { method: 'QRIS', payments: 1, amount: 30_000 },
      { method: 'EDC_DEBIT', payments: 0, amount: 0 },
      { method: 'EDC_CREDIT', payments: 0, amount: 0 },
    ]);
  });

  it('per jam: 10.00 = 2 order 80.000; 19.00 = 1 order, 20.000 − 10.000 refund = 10.000; jam lain kosong', () => {
    expect(r.byHour[10]).toEqual({ hour: 10, orders: 2, net: 80_000 });
    expect(r.byHour[19]).toEqual({ hour: 19, orders: 1, net: 10_000 });
    expect(r.byHour[12]).toEqual({ hour: 12, orders: 0, net: 0 });
    expect(r.byHour).toHaveLength(24);
    expect(r.byHour.reduce((a, h) => a + h.net, 0)).toBe(r.totals.net);
  });

  it('per hari mengisi satu hari ini dan cocok dengan total', () => {
    expect(r.byDay).toEqual([{ date: DAY, orders: 3, net: 90_000 }]);
  });

  it('per kasir: budi 2 order 70.000, void 1 (15.000, sebelum bayar), refund 1, diskon 1; sari 1 order 30.000, void setelah bayar 40.000', () => {
    expect(r.byCashier).toEqual([
      { userId: 'budi', orders: 2, sales: 70_000, voids: 1, voidAmount: 15_000, voidsAfterPayment: 0, refunds: 1, refundAmount: 10_000, discounts: 1, discountAmount: 5_000 },
      { userId: 'sari', orders: 1, sales: 30_000, voids: 1, voidAmount: 40_000, voidsAfterPayment: 1, refunds: 0, refundAmount: 0, discounts: 0, discountAmount: 0 },
    ]);
  });

  it('selisih kas shift tercatat dengan tanda: kurang = negatif', () => {
    expect(r.cashCounts.toleranceAmount).toBe(5_000);
    expect(r.cashCounts.shifts).toEqual([
      expect.objectContaining({ shiftId: 'S1', userId: 'budi', counted: 495_000, expected: 500_000, diff: -5_000 }),
    ]);
  });

  it('jumlah per hari, per jam, dan per metode semuanya sama dengan total bersih', () => {
    expect(r.byDay.reduce((a, d) => a + d.net, 0)).toBe(r.totals.net);
    expect(r.byMethod.reduce((a, m) => a + m.amount, 0)).toBe(r.totals.net);
    expect(r.byCashier.reduce((a, c) => a + c.sales, 0)).toBe(r.totals.gross);
  });

  it('tanpa item pada tagihan: rincian produk kosong dan 3 order terhitung "tanpa rincian"', () => {
    expect(r.byProduct).toEqual([]);
    expect(r.ordersWithoutItems).toBe(3);
  });
});

describe('laporan penjualan: batas dan kasus tepi', () => {
  it('tanpa event: semua nol, rata-rata 0 (bukan NaN), hari kosong tetap tercantum', () => {
    const r = report(new Sim('o1', DAY), { from: '2026-09-29', to: '2026-10-01' });
    expect(r.totals).toMatchObject({ gross: 0, net: 0, orders: 0, avgOrder: 0 });
    expect(r.byDay.map((d) => d.date)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01']);
    expect(r.byCashier).toEqual([]);
  });

  it('hari mengikuti zona waktu outlet: 06:30 WIB masih hari itu di WIB, tetapi hari sebelumnya di UTC', () => {
    const s = new Sim('o1', DAY);
    created(s, 'a', '06:25:00'); pay(s, 'a', '06:30:00', 10_000);
    expect(report(s, { off: 420 }).totals.gross).toBe(10_000);
    expect(report(s, { off: 0 }).totals.gross).toBe(0);
    const utcPrev = report(s, { off: 0, from: '2026-09-30', to: '2026-09-30' });
    expect(utcPrev.totals.gross).toBe(10_000);
    expect(utcPrev.byHour[23]!.net).toBe(10_000);
  });

  it('pembayaran 23:59 dan 00:01 jatuh ke hari berbeda; satu order dihitung sekali pada pembayaran pertama (split bill)', () => {
    const s = new Sim('o1', DAY);
    created(s, 'a', '23:50:00');
    pay(s, 'a', '23:59:00', 30_000);
    pay(s, 'a', s.t('23:59:00') + 2 * 60_000, 20_000, 'QRIS'); // 00:01 hari berikutnya
    const r = report(s, { from: DAY, to: '2026-10-02' });
    expect(r.byDay).toEqual([{ date: DAY, orders: 1, net: 30_000 }, { date: '2026-10-02', orders: 0, net: 20_000 }]);
    expect(r.totals).toMatchObject({ gross: 50_000, orders: 1 });
    expect(r.byMethod.filter((m) => m.payments > 0).map((m) => m.method)).toEqual(['CASH', 'QRIS']);
  });

  it('event di luar rentang tidak dihitung', () => {
    const s = new Sim('o1', DAY);
    created(s, 'a', '10:00:00'); pay(s, 'a', '10:05:00', 10_000);
    created(s, 'b', s.t('10:00:00') + DAY_MS); pay(s, 'b', s.t('10:05:00') + DAY_MS, 99_000);
    expect(report(s).totals.gross).toBe(10_000);
  });

  it('order yang di-void di hari berikutnya tidak dihitung sebagai penjualan hari pembayarannya, dan void-nya muncul di hari void', () => {
    const s = new Sim('o1', DAY);
    created(s, 'a', '20:00:00'); pay(s, 'a', '20:05:00', 25_000);
    voidOrder(s, 'a', s.t('09:00:00') + DAY_MS, 25_000);
    const day1 = report(s, { now: s.t('12:00:00') + DAY_MS });
    expect(day1.totals).toMatchObject({ gross: 0, net: 0, orders: 0 });
    expect(day1.totals.voids.count).toBe(0);
    const day2 = report(s, { from: '2026-10-02', to: '2026-10-02', now: s.t('12:00:00') + DAY_MS });
    expect(day2.totals.voids).toEqual({ count: 1, amount: 25_000, afterPayment: { count: 1, amount: 25_000 } });
  });

  it('refund atas order yang di-void diabaikan agar tidak terhitung dua kali', () => {
    const s = new Sim('o1', DAY);
    created(s, 'a', '10:00:00'); pay(s, 'a', '10:05:00', 25_000); voidOrder(s, 'a', '10:10:00', 25_000);
    s.pos({ type: 'refund.created', payload: { refundId: 'a-R1', originalOrderId: 'a', amount: 25_000, method: 'CASH', approverId: 'hendra' } }, '10:12:00');
    expect(report(s).totals).toMatchObject({ gross: 0, refunds: 0, net: 0 });
  });

  it('event bertanggal jauh di masa depan diabaikan dan dicatat', () => {
    const s = new Sim('o1', DAY);
    created(s, 'a', '10:00:00'); pay(s, 'a', '10:05:00', 10_000);
    created(s, 'b', s.t('10:00:00') + 40 * DAY_MS); pay(s, 'b', s.t('10:05:00') + 40 * DAY_MS, 88_000);
    const r = report(s, { from: DAY, to: '2026-11-15', now: NOW });
    expect(r.totals.gross).toBe(10_000);
    expect(r.notes.join(' ')).toMatch(/2 event bertanggal lebih dari sehari di masa depan diabaikan/);
  });

  it('order karyawan tidak pernah jadi penjualan walau punya pembayaran', () => {
    const s = new Sim('o1', DAY);
    created(s, 'm', '12:00:00', 'budi', 'EMPLOYEE', 'andi'); pay(s, 'm', '12:05:00', 18_000);
    const r = report(s);
    expect(r.totals).toMatchObject({ gross: 0, orders: 0, employeeMeals: 1 });
  });

  it('tanggal pembantu: addDays dan localDate', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(localDate(Date.parse('2026-10-01T17:30:00Z'), 420)).toBe('2026-10-02');
  });
});


describe('laporan penjualan: rincian per produk', () => {
  const line = (itemId: string, name: string, qty: number, unitPrice: number) => ({ itemId, name, qty, unitPrice });
  const bill = (s: Sim, id: string, at: string | number, items: ReturnType<typeof line>[], actor = 'budi') =>
    s.pos({ type: 'bill.printed', payload: { orderId: id, total: items.reduce((a, l) => a + l.qty * l.unitPrice, 0), items } }, at, actor);

  // a: 2 kopi (22.000) + 1 matcha (28.000) = 72.000, lunas
  // b: 1 kopi = 22.000, lunas
  // c: 3 matcha = 84.000, lunas lalu di-void -> tidak dihitung
  // d: 1 latte, tanpa pembayaran -> tidak dihitung
  // e: order karyawan 2 kopi -> tidak dihitung
  // f: tagihan lama tanpa item, lunas 10.000 -> "tanpa rincian"
  function menuDay(): Sim {
    const s = new Sim('o1', DAY);
    created(s, 'a', '10:00:00'); bill(s, 'a', '10:04:00', [line('kopi', 'Kopi Susu', 2, 22_000), line('matcha', 'Matcha Latte', 1, 28_000)]); pay(s, 'a', '10:05:00', 72_000);
    created(s, 'b', '11:00:00'); bill(s, 'b', '11:04:00', [line('kopi', 'Kopi Susu', 1, 22_000)]); pay(s, 'b', '11:05:00', 22_000);
    created(s, 'c', '12:00:00'); bill(s, 'c', '12:04:00', [line('matcha', 'Matcha Latte', 3, 28_000)]); pay(s, 'c', '12:05:00', 84_000); voidOrder(s, 'c', '12:30:00', 84_000);
    created(s, 'd', '13:00:00'); bill(s, 'd', '13:04:00', [line('latte', 'Latte', 1, 26_000)]);
    created(s, 'e', '14:00:00', 'budi', 'EMPLOYEE', 'andi'); bill(s, 'e', '14:04:00', [line('kopi', 'Kopi Susu', 2, 22_000)]); pay(s, 'e', '14:05:00', 44_000);
    created(s, 'f', '15:00:00'); s.pos({ type: 'bill.printed', payload: { orderId: 'f', total: 10_000 } }, '15:04:00', 'budi'); pay(s, 'f', '15:05:00', 10_000);
    return s;
  }

  it('kopi 3 × 22.000 = 66.000 dan matcha 1 × 28.000; order void, belum bayar, dan karyawan tidak masuk; urut nilai', () => {
    const r = report(menuDay());
    expect(r.byProduct).toEqual([
      { itemId: 'kopi', name: 'Kopi Susu', qty: 3, amount: 66_000 },
      { itemId: 'matcha', name: 'Matcha Latte', qty: 1, amount: 28_000 },
    ]);
  });

  it('order lama tanpa item dihitung sebagai penjualan tetapi dilaporkan sebagai tanpa rincian', () => {
    const r = report(menuDay());
    expect(r.totals).toMatchObject({ orders: 3, gross: 104_000 });
    expect(r.ordersWithoutItems).toBe(1);
  });

  it('tagihan dicetak ulang: yang terakhir yang dipakai, tidak dihitung dua kali', () => {
    const s = new Sim('o1', DAY);
    created(s, 'a', '10:00:00');
    bill(s, 'a', '10:03:00', [line('kopi', 'Kopi Susu', 1, 22_000)]);
    bill(s, 'a', '10:04:00', [line('kopi', 'Kopi Susu', 2, 22_000)]);
    pay(s, 'a', '10:05:00', 44_000);
    expect(report(s).byProduct).toEqual([{ itemId: 'kopi', name: 'Kopi Susu', qty: 2, amount: 44_000 }]);
  });

  it('produk dihitung pada rentang pembayaran: order dibayar di luar rentang tidak masuk', () => {
    const s = new Sim('o1', DAY);
    created(s, 'a', '10:00:00'); bill(s, 'a', '10:04:00', [line('kopi', 'Kopi Susu', 1, 22_000)]); pay(s, 'a', s.t('10:05:00') + DAY_MS, 22_000);
    expect(report(s).byProduct).toEqual([]);
    expect(report(s, { from: '2026-10-02', to: '2026-10-02', now: s.t('12:00:00') + DAY_MS }).byProduct).toHaveLength(1);
  });

  it('harga berubah di tengah hari: dua baris dengan harga berbeda dijumlah per itemId, nama terbaru dipakai', () => {
    const s = new Sim('o1', DAY);
    created(s, 'a', '09:00:00'); bill(s, 'a', '09:04:00', [line('kopi', 'Kopi Susu', 1, 20_000)]); pay(s, 'a', '09:05:00', 20_000);
    created(s, 'b', '16:00:00'); bill(s, 'b', '16:04:00', [line('kopi', 'Kopi Susu Gula Aren', 1, 24_000)]); pay(s, 'b', '16:05:00', 24_000);
    expect(report(s).byProduct).toEqual([{ itemId: 'kopi', name: 'Kopi Susu Gula Aren', qty: 2, amount: 44_000 }]);
  });
});

describe('laporan penjualan: varian dan tambahan', () => {
  const large = { group: 'Ukuran', name: 'Large', price: 6_000 };
  const boba = { group: 'Topping', name: 'Boba', price: 6_000 };
  const oat = { group: 'Topping', name: 'Oat Milk', price: 8_000 };
  const bill = (s: Sim, id: string, at: string, items: object[], total: number) =>
    s.pos({ type: 'bill.printed', payload: { orderId: id, total, items } } as never, at, 'budi');

  it('opsi dijumlah per porsi: a = 2 matcha (Large+Boba) 40.000/porsi, b = 1 matcha (Large+Oat) 42.000; void tidak dihitung', () => {
    const s = new Sim('o1', DAY);
    created(s, 'a', '10:00:00'); bill(s, 'a', '10:04:00', [{ itemId: 'matcha', name: 'Matcha', qty: 2, unitPrice: 40_000, options: [large, boba] }], 80_000); pay(s, 'a', '10:05:00', 80_000);
    created(s, 'b', '11:00:00'); bill(s, 'b', '11:04:00', [{ itemId: 'matcha', name: 'Matcha', qty: 1, unitPrice: 42_000, options: [large, oat] }], 42_000); pay(s, 'b', '11:05:00', 42_000);
    created(s, 'c', '12:00:00'); bill(s, 'c', '12:04:00', [{ itemId: 'matcha', name: 'Matcha', qty: 5, unitPrice: 40_000, options: [large, boba] }], 200_000); pay(s, 'c', '12:05:00', 200_000); voidOrder(s, 'c', '12:30:00', 200_000);
    const r = report(s);
    expect(r.byProduct).toEqual([{ itemId: 'matcha', name: 'Matcha', qty: 3, amount: 80_000 + 42_000 }]);
    expect(r.byOption).toEqual([
      { group: 'Ukuran', name: 'Large', qty: 3, amount: 18_000 },
      { group: 'Topping', name: 'Boba', qty: 2, amount: 12_000 },
      { group: 'Topping', name: 'Oat Milk', qty: 1, amount: 8_000 },
    ]);
  });

  it('tanpa opsi: daftar kosong', () => {
    expect(report(busyDay()).byOption).toEqual([]);
  });
});

describe('laporan penjualan: pisah bill dan gabung order', () => {
  const kopi = (qty: number) => ({ itemId: 'kopi', name: 'Kopi', qty, unitPrice: 22_000 });
  const bill = (s: Sim, id: string, at: string, items: object[], total: number) =>
    s.pos({ type: 'bill.printed', payload: { orderId: id, total, items } } as never, at, 'budi');

  it('pisah bill: dua pembayaran = dua order, produk dijumlahkan sekali (3 kopi, bukan 4)', () => {
    const s = new Sim('o1', DAY);
    created(s, 'a', '10:00:00');
    created(s, 'b', '10:20:00');
    s.pos({ type: 'order.items_moved', payload: { fromOrderId: 'a', toOrderId: 'b', kind: 'SPLIT', items: [kopi(1)], sent: false } }, '10:20:01', 'budi');
    bill(s, 'a', '10:30:00', [kopi(2)], 44_000); pay(s, 'a', '10:31:00', 44_000);
    bill(s, 'b', '10:32:00', [kopi(1)], 22_000); pay(s, 'b', '10:33:00', 22_000, 'QRIS');
    const r = report(s);
    expect(r.totals).toMatchObject({ gross: 66_000, orders: 2, avgOrder: 33_000 });
    expect(r.byProduct).toEqual([{ itemId: 'kopi', name: 'Kopi', qty: 3, amount: 66_000 }]);
  });

  it('gabung order: order asal tanpa pembayaran tidak menambah apa pun; hanya order tujuan terhitung', () => {
    const s = new Sim('o1', DAY);
    created(s, 'a', '10:00:00'); created(s, 'b', '10:05:00');
    s.pos({ type: 'order.items_moved', payload: { fromOrderId: 'b', toOrderId: 'a', kind: 'MERGE', items: [kopi(1)], sent: false } }, '10:06:00', 'budi');
    bill(s, 'a', '10:30:00', [kopi(3)], 66_000); pay(s, 'a', '10:31:00', 66_000);
    const r = report(s);
    expect(r.totals).toMatchObject({ gross: 66_000, orders: 1 });
    expect(r.byProduct).toEqual([{ itemId: 'kopi', name: 'Kopi', qty: 3, amount: 66_000 }]);
  });
});

describe('laporan penjualan: bill tunai ditahan lama', () => {
  const hold = (s: Sim, id: string, at: string, reason: string, heldMinutes: number) =>
    s.pos({ type: 'bill.hold_reason', payload: { orderId: id, reason, heldMinutes } }, at, 'budi');

  it('dikelompokkan per alasan dengan jumlah dan lama terlama; order void dan karyawan tidak dihitung', () => {
    const s = new Sim('o1', DAY);
    created(s, 'a', '10:00:00'); hold(s, 'a', '11:10:00', 'STILL_DINING', 70); pay(s, 'a', '11:10:01', 10_000);
    created(s, 'b', '10:00:00'); hold(s, 'b', '12:30:00', 'STILL_DINING', 150); pay(s, 'b', '12:30:01', 10_000);
    created(s, 'c', '10:00:00'); hold(s, 'c', '13:00:00', 'OTHER', 61); pay(s, 'c', '13:00:01', 10_000);
    created(s, 'd', '10:00:00'); hold(s, 'd', '13:00:00', 'OTHER', 90); pay(s, 'd', '13:00:01', 10_000); voidOrder(s, 'd', '13:10:00', 10_000);
    created(s, 'e', '10:00:00', 'budi', 'EMPLOYEE', 'andi'); hold(s, 'e', '13:00:00', 'OTHER', 99);
    expect(report(s).holds).toEqual([
      { reason: 'STILL_DINING', count: 2, longestMinutes: 150 },
      { reason: 'OTHER', count: 1, longestMinutes: 61 },
    ]);
  });

  it('tanpa bill ditahan: daftar kosong', () => {
    expect(report(busyDay()).holds).toEqual([]);
  });
});

