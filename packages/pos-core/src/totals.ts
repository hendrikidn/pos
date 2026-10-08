import type { CartLine, OrderRecord, PosConfig } from './types';

export interface Totals {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
}

export function computeTotals(items: CartLine[], discount: number, taxPercent: number): Totals {
  const subtotal = items.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  const taxable = Math.max(0, subtotal - discount);
  const tax = Math.round((taxable * taxPercent) / 100);
  return { subtotal, discount, tax, total: taxable + tax };
}

/** Nama baris untuk tampilan dan cetak: "Kopi Susu (Large, Oat Milk)". */
export function lineLabel(l: Pick<CartLine, 'name' | 'options'>): string {
  return l.options && l.options.length > 0 ? `${l.name} (${l.options.map((o) => o.name).join(', ')})` : l.name;
}

export const paidTotal = (o: OrderRecord) => o.payments.reduce((s, p) => s + p.amount, 0);

const rp = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;
const line = (l: string, r: string, w = 32) => l + ' '.repeat(Math.max(1, w - l.length - r.length)) + r;

export function renderBill(o: OrderRecord, cfg: PosConfig, title = 'BILL'): string {
  const t = computeTotals(o.items, o.discount, cfg.taxPercent);
  return [
    cfg.merchantName,
    title,
    `Order ${o.id}${o.tableNo ? `  Meja ${o.tableNo}` : ''}`,
    '--------------------------------',
    ...o.items.map((i) => line(`${i.qty}x ${lineLabel(i)}`, rp(i.qty * i.unitPrice))),
    '--------------------------------',
    line('Subtotal', rp(t.subtotal)),
    ...(t.discount > 0 ? [line('Diskon', `-${rp(t.discount)}`)] : []),
    ...(t.tax > 0 ? [line(`PBJT ${cfg.taxPercent}%`, rp(t.tax))] : []),
    line('TOTAL', rp(t.total)),
  ].join('\n');
}

export function renderReceipt(o: OrderRecord, cfg: PosConfig): string {
  const paid = o.payments.map((p) => line(p.method === 'CASH' ? 'Tunai' : p.method, rp(p.amount)));
  return [renderBill(o, cfg, 'STRUK PEMBAYARAN'), '--------------------------------', ...paid, 'Terima kasih'].join('\n');
}

export function renderKitchenTicket(o: OrderRecord): string {
  return [
    `DAPUR  ${o.id}${o.tableNo ? `  Meja ${o.tableNo}` : ''}`,
    ...o.items.flatMap((i) => [`${i.qty}x ${lineLabel(i)}`, ...(i.note ? [`   * ${i.note}`] : [])]),
  ].join('\n');
}
