import type { CartLine, OrderRecord, PosConfig } from './types';

export interface Totals {
  subtotal: number;
  discount: number;
  /** Service charge (biaya layanan), dihitung dari subtotal setelah diskon. */
  service: number;
  tax: number;
  /** Pembulatan ke kelipatan `roundingUnit` (bisa negatif); sudah termasuk dalam `total`. */
  rounding: number;
  total: number;
}

/** Aturan harga satu outlet. */
export interface PricingRules {
  taxPercent: number;
  /** Persen service charge; 0/kosong = tidak ada. */
  servicePercent?: number;
  /** Pajak (PBJT) dikenakan juga atas service charge (bawaan ya, sesuai praktik restoran). */
  taxOnService?: boolean;
  /** Pembulatan total ke kelipatan ini (100, 500, 1000); 0/kosong = tidak dibulatkan. */
  roundingUnit?: number;
}

export const pricingOf = (cfg: Pick<PosConfig, 'taxPercent' | 'serviceChargePercent' | 'taxOnService' | 'roundingUnit'>): PricingRules => ({
  taxPercent: cfg.taxPercent, servicePercent: cfg.serviceChargePercent, taxOnService: cfg.taxOnService, roundingUnit: cfg.roundingUnit,
});

/**
 * Urutan hitung: subtotal − diskon = dasar; service = dasar × persen; pajak = (dasar + service bila `taxOnService`) × persen pajak;
 * total sebelum pembulatan = dasar + service + pajak; pembulatan = total dibulatkan terdekat ke kelipatan `roundingUnit` − total sebelumnya.
 * Bilangan bulat rupiah di setiap langkah (pembulatan terdekat), sehingga bill, struk, laporan, dan akuntansi memakai angka yang sama.
 */
export function computeTotals(items: CartLine[], discount: number, rules: PricingRules | number): Totals {
  const r: PricingRules = typeof rules === 'number' ? { taxPercent: rules } : rules;
  const subtotal = items.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  const base = Math.max(0, subtotal - discount);
  const service = Math.round((base * (r.servicePercent ?? 0)) / 100);
  const tax = Math.round(((base + (r.taxOnService === false ? 0 : service)) * r.taxPercent) / 100);
  const before = base + service + tax;
  const unit = r.roundingUnit ?? 0;
  const total = unit > 0 ? Math.round(before / unit) * unit : before;
  return { subtotal, discount, service, tax, rounding: total - before, total };
}

/** Nama baris untuk tampilan dan cetak: "Kopi Susu (Large, Oat Milk)". */
export function lineLabel(l: Pick<CartLine, 'name' | 'options'>): string {
  return l.options && l.options.length > 0 ? `${l.name} (${l.options.map((o) => o.name).join(', ')})` : l.name;
}

export const paidTotal = (o: OrderRecord) => o.payments.reduce((s, p) => s + p.amount, 0);

const rp = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;
const line = (l: string, r: string, w = 32) => l + ' '.repeat(Math.max(1, w - l.length - r.length)) + r;

export function renderBill(o: OrderRecord, cfg: PosConfig, title = 'BILL'): string {
  const t = computeTotals(o.items, o.discount, pricingOf(cfg));
  return [
    cfg.merchantName,
    title,
    `Order ${o.id}${o.tableNo ? `  Meja ${o.tableNo}` : ''}`,
    '--------------------------------',
    ...o.items.map((i) => line(`${i.qty}x ${lineLabel(i)}`, rp(i.qty * i.unitPrice))),
    '--------------------------------',
    line('Subtotal', rp(t.subtotal)),
    ...(t.discount > 0 ? [line('Diskon', `-${rp(t.discount)}`)] : []),
    ...(t.service > 0 ? [line(`Service ${cfg.serviceChargePercent}%`, rp(t.service))] : []),
    ...(t.tax > 0 ? [line(`PBJT ${cfg.taxPercent}%`, rp(t.tax))] : []),
    ...(t.rounding !== 0 ? [line('Pembulatan', `${t.rounding < 0 ? '-' : ''}${rp(Math.abs(t.rounding))}`)] : []),
    line('TOTAL', rp(t.total)),
  ].join('\n');
}

const METHOD_NAME: Record<string, string> = { CASH: 'Tunai', QRIS: 'QRIS', EDC_DEBIT: 'Kartu debit', EDC_CREDIT: 'Kartu kredit', PLATFORM: 'Platform online', DEPOSIT: 'Uang muka' };

export function renderReceipt(o: OrderRecord, cfg: PosConfig): string {
  const paid = o.payments.map((p) => line(METHOD_NAME[p.method] ?? p.method, rp(p.amount)));
  return [renderBill(o, cfg, 'STRUK PEMBAYARAN'), '--------------------------------', ...paid, 'Terima kasih'].join('\n');
}

export function renderKitchenTicket(o: OrderRecord): string {
  return [
    `DAPUR  ${o.id}${o.tableNo ? `  Meja ${o.tableNo}` : ''}`,
    ...o.items.flatMap((i) => [`${i.qty}x ${lineLabel(i)}`, ...(i.note ? [`   * ${i.note}`] : [])]),
  ].join('\n');
}
