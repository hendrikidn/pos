import { correctedTime, type EventOf, type PosEvent } from '@pos/events';
import { DEFAULT_CONFIG } from '@pos/rules';

export const DAY_MS = 86_400_000;
export const METHODS = ['CASH', 'QRIS', 'EDC_DEBIT', 'EDC_CREDIT', 'PLATFORM', 'DEPOSIT'] as const;
type Method = (typeof METHODS)[number];

export interface SalesReportInput {
  /** payment.received, refund.created, discount.applied, cash.counted, order.created, bill.printed, dan void.approved. Tipe lain diabaikan. */
  events: PosEvent[];
  /** Batas waktu terkoreksi, [fromMs, toMs). */
  fromMs: number;
  toMs: number;
  /** Tanggal lokal outlet (YYYY-MM-DD) awal dan akhir, inklusif; dipakai sebagai label dan untuk mengisi hari kosong. */
  from: string;
  to: string;
  utcOffsetMinutes: number;
  now: number;
  /** Hasil hitung ulang kas oleh server (lihat cash-check.ts). Bila ada, `expected` di laporan memakai angka server. */
  cashChecks?: { deviceId: string; seq: number; claimed: number; serverExpected: number }[];
}

export interface CashierRow {
  userId: string;
  orders: number;
  sales: number;
  voids: number;
  voidAmount: number;
  voidsAfterPayment: number;
  refunds: number;
  refundAmount: number;
  discounts: number;
  discountAmount: number;
}

export interface ProductRow {
  itemId: string;
  name: string;
  qty: number;
  /** Harga satuan × jumlah, sebelum diskon dan pajak. */
  amount: number;
}

export interface HoldRow {
  reason: string;
  count: number;
  /** Lama tahan terpanjang untuk alasan ini (menit). */
  longestMinutes: number;
}

export interface OptionRow {
  group: string;
  name: string;
  /** Berapa kali opsi ini dipilih (jumlah porsi). */
  qty: number;
  /** Tambahan harga dari opsi ini: harga opsi × porsi. */
  amount: number;
}

export interface SalesReport {
  range: { from: string; to: string; days: number; utcOffsetMinutes: number; generatedAt: number };
  totals: {
    /** Penerimaan dari order yang tidak di-void, sebelum refund. */
    gross: number;
    refunds: number;
    /** gross − refund. */
    net: number;
    orders: number;
    avgOrder: number;
    discount: { count: number; amount: number };
    /** Void di rentang ini. `afterPayment`: order sudah dibayar sebelum di-void (uangnya sudah diterima). */
    voids: { count: number; amount: number; afterPayment: { count: number; amount: number } };
    employeeMeals: number;
  };
  byDay: { date: string; orders: number; net: number }[];
  byHour: { hour: number; orders: number; net: number }[];
  byMethod: { method: Method; payments: number; amount: number }[];
  byCashier: CashierRow[];
  /** Produk terjual dari order yang dihitung sebagai penjualan, urut nilai terbesar. Nilai kotor: sebelum diskon dan pajak. */
  byProduct: ProductRow[];
  /** Bill tunai yang dibayar setelah ditahan melewati batas, dikelompokkan menurut alasan kasir (kontrol bill recycling). */
  holds: HoldRow[];
  /** Varian dan tambahan yang dipilih pada order yang dihitung, urut jumlah terbanyak. */
  byOption: OptionRow[];
  /** Order terhitung yang tagihannya tidak membawa rincian item (terminal versi lama): tidak ada di `byProduct`. */
  ordersWithoutItems: number;
  cashCounts: {
    toleranceAmount: number;
    /**
     * `expected`: kas yang seharusnya menurut server bila terverifikasi, selain itu menurut terminal. `verified`: dihitung ulang server.
     * `claimed`: yang dilaporkan terminal, hanya ada bila berbeda dari angka server (indikasi klien dimodifikasi; juga temuan R30).
     */
    shifts: { shiftId: string; userId: string | null; terminalId: string; at: number; counted: number; expected: number; diff: number; verified: boolean; claimed?: number }[];
  };
  notes: string[];
}

export function localDate(ms: number, offsetMinutes: number): string {
  return new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function localHour(ms: number, offsetMinutes: number): number {
  return new Date(ms + offsetMinutes * 60_000).getUTCHours();
}

/** Awal hari lokal (epoch ms) untuk tanggal YYYY-MM-DD di zona dengan offset tertentu. */
export function startOfLocalDay(date: string, offsetMinutes: number): number {
  return Date.parse(`${date}T00:00:00Z`) - offsetMinutes * 60_000;
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Laporan penjualan satu outlet dari event POS.
 *
 * Aturan hitung (sengaja konservatif, dan dijelaskan di halaman laporan):
 *  - Order karyawan tidak dihitung sebagai penjualan.
 *  - Order yang kemudian di-void tidak dihitung sebagai penjualan, kapan pun void-nya. Uang yang sudah diterima untuk
 *    order itu muncul sebagai "void setelah dibayar", karena itulah pola yang perlu dicek owner (uang masuk, order dibatalkan).
 *  - Refund atas order yang di-void diabaikan agar pembatalan tidak terhitung dua kali.
 *  - Satu order dihitung sekali, pada hari dan jam pembayaran pertamanya.
 */
export function buildSalesReport(input: SalesReportInput): SalesReport {
  const { fromMs, toMs, utcOffsetMinutes: off, now } = input;
  const t = correctedTime;
  const inRange = (e: PosEvent) => t(e) >= fromMs && t(e) < toMs;
  let futureIgnored = 0;
  const events = input.events.filter((e) => {
    if (t(e) > now + DAY_MS) {
      futureIgnored++;
      return false;
    }
    return true;
  });

  // ---- keadaan order: jenis, pembayaran, dan void (event dapat berasal dari luar rentang) ----
  const employee = new Set<string>();
  const voided = new Map<string, EventOf<'void.approved'>>();
  const paidEver = new Set<string>();
  /** Rincian item final per order: bill terakhir yang membawa item. */
  const billItems = new Map<string, EventOf<'bill.printed'>>();
  for (const e of events) {
    if (e.type === 'bill.printed' && e.payload.items) {
      const prev = billItems.get(e.payload.orderId);
      if (!prev || t(e) >= t(prev)) billItems.set(e.payload.orderId, e);
    }
    if (e.type === 'order.created' && e.payload.orderType === 'EMPLOYEE') employee.add(e.payload.orderId);
    else if (e.type === 'void.approved' && !voided.has(e.payload.orderId)) voided.set(e.payload.orderId, e);
    else if (e.type === 'payment.received') paidEver.add(e.payload.orderId);
  }
  const counts = (orderId: string) => !employee.has(orderId) && !voided.has(orderId);

  const days = new Map<string, { orders: number; net: number }>();
  for (let d = input.from; d <= input.to; d = addDays(d, 1)) days.set(d, { orders: 0, net: 0 });
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0, net: 0 }));
  const methods = new Map<Method, { payments: number; amount: number }>(METHODS.map((m) => [m, { payments: 0, amount: 0 }]));
  const cashiers = new Map<string, CashierRow>();
  const cashier = (id: string): CashierRow => {
    let c = cashiers.get(id);
    if (!c) {
      c = { userId: id, orders: 0, sales: 0, voids: 0, voidAmount: 0, voidsAfterPayment: 0, refunds: 0, refundAmount: 0, discounts: 0, discountAmount: 0 };
      cashiers.set(id, c);
    }
    return c;
  };
  const addMoney = (at: number, amount: number) => {
    const d = days.get(localDate(at, off));
    if (d) d.net += amount;
    const h = hours[localHour(at, off)]!;
    h.net += amount;
  };

  let gross = 0;
  let refunds = 0;
  const countedOrders = new Set<string>();
  const totals = {
    discount: { count: 0, amount: 0 },
    voids: { count: 0, amount: 0, afterPayment: { count: 0, amount: 0 } },
    employeeMeals: 0,
  };
  const products = new Map<string, ProductRow>();
  const optionRows = new Map<string, OptionRow>();
  const holdRows = new Map<string, HoldRow>();
  let ordersWithoutItems = 0;
  const ordered = [...events].sort((a, b) => t(a) - t(b) || a.seq - b.seq);

  for (const e of ordered) {
    if (!inRange(e)) continue;
    switch (e.type) {
      case 'payment.received': {
        const { orderId, amount, method } = e.payload;
        if (!counts(orderId)) break;
        gross += amount;
        addMoney(t(e), amount);
        const m = methods.get(method);
        if (m) {
          m.payments += 1;
          m.amount += amount;
        }
        if (!countedOrders.has(orderId)) {
          countedOrders.add(orderId);
          const d = days.get(localDate(t(e), off));
          if (d) d.orders += 1;
          hours[localHour(t(e), off)]!.orders += 1;
          const lines = billItems.get(orderId)?.payload.items;
          if (!lines) ordersWithoutItems += 1;
          else {
            for (const l of lines) {
              const row = products.get(l.itemId) ?? { itemId: l.itemId, name: l.name, qty: 0, amount: 0 };
              row.qty += l.qty;
              row.amount += l.qty * l.unitPrice;
              row.name = l.name;
              products.set(l.itemId, row);
              for (const op of l.options ?? []) {
                const key = `${op.group}\u0000${op.name}`;
                const orow = optionRows.get(key) ?? { group: op.group, name: op.name, qty: 0, amount: 0 };
                orow.qty += l.qty;
                orow.amount += l.qty * op.price;
                optionRows.set(key, orow);
              }
            }
          }
          if (e.actorId) cashier(e.actorId).orders += 1;
        }
        if (e.actorId) cashier(e.actorId).sales += amount;
        break;
      }
      case 'refund.created': {
        const { originalOrderId, amount, method } = e.payload;
        if (!counts(originalOrderId)) break;
        refunds += amount;
        addMoney(t(e), -amount);
        const m = methods.get(method);
        if (m) m.amount -= amount;
        if (e.actorId) {
          const c = cashier(e.actorId);
          c.refunds += 1;
          c.refundAmount += amount;
        }
        break;
      }
      case 'discount.applied': {
        if (!counts(e.payload.orderId)) break;
        totals.discount.count += 1;
        totals.discount.amount += e.payload.amount;
        if (e.actorId) {
          const c = cashier(e.actorId);
          c.discounts += 1;
          c.discountAmount += e.payload.amount;
        }
        break;
      }
      case 'void.approved': {
        const { orderId, amount } = e.payload;
        if (employee.has(orderId) || voided.get(orderId) !== e) break;
        const after = paidEver.has(orderId);
        totals.voids.count += 1;
        totals.voids.amount += amount;
        if (after) {
          totals.voids.afterPayment.count += 1;
          totals.voids.afterPayment.amount += amount;
        }
        if (e.actorId) {
          const c = cashier(e.actorId);
          c.voids += 1;
          c.voidAmount += amount;
          if (after) c.voidsAfterPayment += 1;
        }
        break;
      }
      case 'bill.hold_reason': {
        if (!counts(e.payload.orderId)) break;
        const row = holdRows.get(e.payload.reason) ?? { reason: e.payload.reason, count: 0, longestMinutes: 0 };
        row.count += 1;
        row.longestMinutes = Math.max(row.longestMinutes, e.payload.heldMinutes);
        holdRows.set(e.payload.reason, row);
        break;
      }
      case 'order.created':
        if (e.payload.orderType === 'EMPLOYEE' && !voided.has(e.payload.orderId)) totals.employeeMeals += 1;
        break;
      default:
        break;
    }
  }

  const checks = new Map((input.cashChecks ?? []).map((c) => [`${c.deviceId}#${c.seq}`, c]));
  const shifts = ordered
    .filter((e): e is EventOf<'cash.counted'> => e.type === 'cash.counted' && inRange(e))
    .map((e) => {
      const c = checks.get(`${e.deviceId}#${e.seq}`);
      const expected = c ? c.serverExpected : e.payload.expected;
      return {
        shiftId: e.payload.shiftId, userId: e.actorId, terminalId: e.deviceId, at: t(e),
        counted: e.payload.counted, expected, diff: e.payload.counted - expected, verified: !!c,
        ...(c && c.claimed !== c.serverExpected ? { claimed: c.claimed } : {}),
      };
    })
    .reverse();

  const orders = countedOrders.size;
  const notes = [
    'Rincian per produk dibaca dari tagihan yang dicetak, sebelum diskon dan pajak. Order dari terminal versi lama tidak membawa item dan tidak muncul di rincian produk.',
    'Order karyawan tidak dihitung sebagai penjualan. Order yang di-void tidak dihitung; uang yang sudah diterima untuk order itu muncul sebagai "void setelah dibayar".',
  ];
  if (futureIgnored > 0) notes.push(`${futureIgnored} event bertanggal lebih dari sehari di masa depan diabaikan (jam perangkat salah?).`);

  return {
    range: { from: input.from, to: input.to, days: days.size, utcOffsetMinutes: off, generatedAt: now },
    totals: { gross, refunds, net: gross - refunds, orders, avgOrder: orders > 0 ? Math.round(gross / orders) : 0, ...totals },
    byDay: [...days].map(([date, v]) => ({ date, ...v })),
    byHour: hours,
    byMethod: METHODS.map((m) => ({ method: m, ...methods.get(m)! })),
    byCashier: [...cashiers.values()].sort((a, b) => b.sales - a.sales || a.userId.localeCompare(b.userId)),
    byProduct: [...products.values()].sort((a, b) => b.amount - a.amount || b.qty - a.qty || a.name.localeCompare(b.name)),
    holds: [...holdRows.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    byOption: [...optionRows.values()].sort((a, b) => b.qty - a.qty || a.group.localeCompare(b.group) || a.name.localeCompare(b.name)),
    ordersWithoutItems,
    cashCounts: { toleranceAmount: DEFAULT_CONFIG.r14ToleranceAmount, shifts },
    notes,
  };
}

/** Selisih satu angka terhadap periode sebelumnya. `pct` kosong bila periode sebelumnya nol (persen tidak terdefinisi). */
export interface Change {
  delta: number;
  pct: number | null;
}

export interface ProductMover {
  itemId: string;
  name: string;
  current: number;
  previous: number;
  delta: number;
}

export interface Comparison {
  previous: { range: SalesReport['range']; totals: SalesReport['totals']; byDay: SalesReport['byDay'] };
  /** Periode ini masih berjalan (memuat hari ini), jadi angkanya belum penuh dibanding periode sebelumnya. */
  partial: boolean;
  change: {
    net: Change;
    gross: Change;
    orders: Change;
    avgOrder: Change;
    refunds: Change;
    discount: Change;
    voids: Change;
    voidsAfterPayment: Change;
  };
  /** Produk yang nilai penjualannya paling naik dan paling turun (maks. 5 masing-masing); yang tidak berubah tidak ikut. */
  movers: { up: ProductMover[]; down: ProductMover[] };
}

export const changeOf = (current: number, previous: number): Change => ({
  delta: current - previous,
  pct: previous === 0 ? null : Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10,
});

/**
 * Membandingkan laporan periode ini dengan periode sebelumnya yang sama panjang. Murni.
 * Produk dicocokkan menurut `itemId`; produk yang hanya ada di salah satu periode dihitung nol di periode lainnya.
 */
export function compareSales(current: SalesReport, previous: SalesReport, today: string): Comparison {
  const c = current.totals;
  const p = previous.totals;
  const prevAmount = new Map(previous.byProduct.map((x) => [x.itemId, x]));
  const rows = new Map<string, ProductMover>();
  for (const x of current.byProduct) rows.set(x.itemId, { itemId: x.itemId, name: x.name, current: x.amount, previous: prevAmount.get(x.itemId)?.amount ?? 0, delta: 0 });
  for (const x of previous.byProduct) if (!rows.has(x.itemId)) rows.set(x.itemId, { itemId: x.itemId, name: x.name, current: 0, previous: x.amount, delta: 0 });
  const movers = [...rows.values()].map((m) => ({ ...m, delta: m.current - m.previous }));
  const byDelta = (a: ProductMover, b: ProductMover) => b.delta - a.delta || a.name.localeCompare(b.name);
  return {
    previous: { range: previous.range, totals: p, byDay: previous.byDay },
    partial: current.range.to >= today,
    change: {
      net: changeOf(c.net, p.net),
      gross: changeOf(c.gross, p.gross),
      orders: changeOf(c.orders, p.orders),
      avgOrder: changeOf(c.avgOrder, p.avgOrder),
      refunds: changeOf(c.refunds, p.refunds),
      discount: changeOf(c.discount.amount, p.discount.amount),
      voids: changeOf(c.voids.count, p.voids.count),
      voidsAfterPayment: changeOf(c.voids.afterPayment.count, p.voids.afterPayment.count),
    },
    movers: {
      up: movers.filter((m) => m.delta > 0).sort(byDelta).slice(0, 5),
      down: movers.filter((m) => m.delta < 0).sort((a, b) => byDelta(b, a)).slice(0, 5),
    },
  };
}
