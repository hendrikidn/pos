import { correctedTime, type LineItem, type OrderType, type PaymentMethod, type PosEvent } from '@pos/events';

/**
 * Struk digital: yang dilihat customer setelah memindai QR. Tanpa data pribadi: tidak memuat kasir, TID, kode approval, atau
 * nomor kartu, hanya isi pesanan, pembayaran per metode, dan status terkini (termasuk bila order kemudian dibatalkan).
 */
export interface Receipt {
  /** Nomor tampilan (bagian akhir id order). */
  ref: string;
  type: OrderType | null;
  table: string | null;
  /** Waktu tagihan dicetak, atau pembayaran pertama bila tagihan tidak tercatat (epoch ms, terkoreksi). */
  issuedAt: number;
  /** UNPAID: belum dibayar. PARTIAL: baru sebagian. PAID: lunas. VOIDED: dibatalkan (uang yang diterima perlu dikembalikan). */
  status: 'UNPAID' | 'PARTIAL' | 'PAID' | 'VOIDED';
  items: { name: string; options: string[]; qty: number; unitPrice: number; amount: number }[];
  /** Tagihan dari terminal lama tidak memuat rincian item. */
  noItems: boolean;
  subtotal: number;
  discount: number;
  /** Service charge dan pembulatan (0 bila outlet tidak memakainya, atau pada tagihan lama tanpa rincian). */
  service: number;
  tax: number;
  rounding: number;
  total: number;
  paid: number;
  payments: { method: PaymentMethod; amount: number; at: number }[];
  refunded: number;
  voidedAt: number | null;
}

const lineAmount = (l: LineItem) => l.qty * l.unitPrice;

/** Menyusun struk satu order dari event-nya (order.created, bill.printed, discount.applied, payment.received, refund.created, void.approved). */
export function buildReceipt(orderId: string, events: PosEvent[]): Receipt | null {
  const mine = events
    .filter((e) => {
      switch (e.type) {
        case 'refund.created': return e.payload.originalOrderId === orderId;
        case 'order.created': case 'order.table_changed': case 'bill.printed': case 'discount.applied': case 'payment.received': case 'void.approved':
          return e.payload.orderId === orderId;
        default: return false;
      }
    })
    .sort((a, b) => correctedTime(a) - correctedTime(b) || a.seq - b.seq);
  if (mine.length === 0) return null;

  let type: OrderType | null = null;
  let table: string | null = null;
  let bill: Extract<PosEvent, { type: 'bill.printed' }> | undefined;
  let discount = 0;
  let refunded = 0;
  let voidedAt: number | null = null;
  const payments: Receipt['payments'] = [];
  for (const e of mine) {
    switch (e.type) {
      case 'order.created':
        type = e.payload.orderType;
        if (e.payload.tableNo) table = e.payload.tableNo;
        break;
      case 'order.table_changed': table = e.payload.to; break;
      case 'bill.printed': bill = e; break; // yang terakhir
      case 'discount.applied': discount += e.payload.amount; break;
      case 'payment.received': payments.push({ method: e.payload.method, amount: e.payload.amount, at: correctedTime(e) }); break;
      case 'refund.created': refunded += e.payload.amount; break;
      case 'void.approved': voidedAt ??= correctedTime(e); break;
      default: break;
    }
  }

  const lines = bill?.payload.items ?? [];
  const subtotal = lines.reduce((s, l) => s + lineAmount(l), 0);
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  const total = bill ? bill.payload.total : paid;
  // Rincian tercatat di tagihan (service, pajak, pembulatan) dipakai apa adanya; tagihan lama menurunkan pajak dari selisih.
  const bd = bill?.payload.breakdown;
  const tax = bd ? bd.tax : bill && lines.length > 0 ? Math.max(0, total - Math.max(0, subtotal - discount)) : 0;
  const status: Receipt['status'] = voidedAt !== null ? 'VOIDED' : paid >= total && paid > 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';
  return {
    ref: orderId.split('-').pop() ?? orderId,
    type, table,
    issuedAt: bill ? correctedTime(bill) : payments[0]?.at ?? correctedTime(mine[0]!),
    status,
    items: lines.map((l) => ({ name: l.name, options: (l.options ?? []).map((o) => o.name), qty: l.qty, unitPrice: l.unitPrice, amount: lineAmount(l) })),
    noItems: !bill || !bill.payload.items,
    subtotal: bd ? bd.subtotal : subtotal, discount: bd ? bd.discount : discount, service: bd?.service ?? 0, tax, rounding: bd?.rounding ?? 0,
    total, paid, payments, refunded, voidedAt,
  };
}
