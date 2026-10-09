import { correctedTime } from '@pos/events';
import { prepareOrders, toCsv } from './sales-export';
import { addDays, localDate, type SalesReportInput } from './sales-report';

/**
 * Laporan pajak bulanan satu outlet: dasar pengenaan, PBJT (pajak restoran) yang dipungut dari pelanggan, service charge, pembulatan, dan omzet,
 * dari event kasir dengan aturan hitung yang sama dengan laporan penjualan (order karyawan dan order yang di-void tidak dihitung; satu order
 * dihitung pada pembayaran pertamanya). Ini bahan setoran dan pelaporan, BUKAN pengganti pembukuan atau nasihat pajak: bentuk pelaporan dan tarif
 * mengikuti peraturan daerah dan status pajak usaha Anda.
 */
export interface TaxOutlet {
  name: string;
  taxPercent: number;
  servicePercent: number;
  taxOnService: boolean;
}

export interface TaxDay {
  date: string;
  orders: number;
  subtotal: number;
  discount: number;
  service: number;
  /** Dasar pengenaan pajak: subtotal − diskon (+ service bila service ikut dikenai pajak). */
  taxBase: number;
  tax: number;
  rounding: number;
  total: number;
}

export interface TaxReport {
  period: { month: string; from: string; to: string };
  outlet: TaxOutlet;
  totals: Omit<TaxDay, 'date'> & {
    /** Omzet di luar pajak: subtotal − diskon + service. Dasar perkiraan PPh final UMKM; service ikut karena bagian pendapatan usaha (konfirmasi ke konsultan pajak). */
    omzet: number;
    platform: { orders: number; total: number };
    /** Refund di bulan ini dan perkiraan pajak di dalamnya (sebanding dengan pajak order asalnya). */
    refunds: { count: number; amount: number; taxEstimate: number };
    netTax: number;
  };
  byDay: TaxDay[];
  /** Order yang tagihannya tidak memuat rincian pajak (event lama): totalnya dihitung, pajaknya tidak. */
  withoutBreakdown: number;
  notes: string[];
}

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function buildTaxReport(input: SalesReportInput, outlet: TaxOutlet, month: string): TaxReport {
  const { fromMs, toMs, utcOffsetMinutes: off } = input;
  const t = correctedTime;
  const { counted, bill, payments, counts, inRange, sorted } = prepareOrders(input);
  const days = new Map<string, TaxDay>();
  for (let d = input.from; d <= input.to; d = addDays(d, 1)) days.set(d, { date: d, orders: 0, subtotal: 0, discount: 0, service: 0, taxBase: 0, tax: 0, rounding: 0, total: 0 });
  let withoutBreakdown = 0;
  const platform = { orders: 0, total: 0 };
  const taxOf = new Map<string, { tax: number; total: number }>();
  for (const { id, first } of counted) {
    const day = days.get(localDate(t(first), off));
    if (!day) continue;
    const b = bill.get(id)?.payload;
    const bd = b?.breakdown;
    day.orders += 1;
    if (!bd || !b) {
      withoutBreakdown += 1;
      day.total += (payments.get(id) ?? []).reduce((s, p) => s + p.payload.amount, 0);
      continue;
    }
    day.subtotal += bd.subtotal;
    day.discount += bd.discount;
    day.service += bd.service;
    day.taxBase += bd.subtotal - bd.discount + (outlet.taxOnService ? bd.service : 0);
    day.tax += bd.tax;
    day.rounding += bd.rounding;
    day.total += b.total;
    taxOf.set(id, { tax: bd.tax, total: b.total });
    if ((payments.get(id) ?? []).some((p) => p.payload.method === 'PLATFORM')) { platform.orders += 1; platform.total += b.total; }
  }
  const refunds = { count: 0, amount: 0, taxEstimate: 0 };
  for (const e of sorted) {
    if (e.type !== 'refund.created' || !inRange(e) || !counts(e.payload.originalOrderId)) continue;
    refunds.count += 1;
    refunds.amount += e.payload.amount;
    const o = taxOf.get(e.payload.originalOrderId);
    if (o && o.total > 0) refunds.taxEstimate += Math.round((e.payload.amount * o.tax) / o.total);
  }
  const byDay = [...days.values()];
  const sum = (k: keyof Omit<TaxDay, 'date'>) => byDay.reduce((s, d) => s + d[k], 0);
  const totals = {
    orders: sum('orders'), subtotal: sum('subtotal'), discount: sum('discount'), service: sum('service'), taxBase: sum('taxBase'), tax: sum('tax'), rounding: sum('rounding'), total: sum('total'),
    omzet: sum('subtotal') - sum('discount') + sum('service'), platform, refunds, netTax: sum('tax') - refunds.taxEstimate,
  };
  const notes = [
    'PBJT (pajak barang dan jasa tertentu atas makanan dan/atau minuman, dulu "pajak restoran") adalah pajak daerah: tarif dan tata cara setor mengikuti peraturan daerah outlet Anda.',
    'Pajak refund adalah perkiraan sebanding dengan pajak order asalnya; pembukuan Anda yang menentukan koreksi yang sebenarnya.',
    'Penjualan lewat platform (GoFood, GrabFood, ShopeeFood) ditandai terpisah karena perlakuan pajaknya bisa berbeda; cocokkan dengan laporan platform.',
    'Laporan ini bukan nasihat pajak. Konfirmasi ke konsultan pajak atau dinas pendapatan daerah sebelum menyetor.',
  ];
  return { period: { month, from: input.from, to: input.to }, outlet, totals, byDay, withoutBreakdown, notes };
}

export function taxReportCsv(r: TaxReport): string {
  const rows = r.byDay.map((d) => [d.date, d.orders, d.subtotal, d.discount, d.service, d.taxBase, d.tax, d.rounding, d.total]);
  rows.push(['TOTAL', r.totals.orders, r.totals.subtotal, r.totals.discount, r.totals.service, r.totals.taxBase, r.totals.tax, r.totals.rounding, r.totals.total]);
  return toCsv({ header: ['Tanggal', 'Order', 'Subtotal', 'Diskon', 'Service', 'Dasar pengenaan pajak', `PBJT ${r.outlet.taxPercent}%`, 'Pembulatan', 'Total tagihan'], rows });
}
