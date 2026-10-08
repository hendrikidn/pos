import { describe, expect, it } from 'vitest';
import { EventChain, type EventBody, type LineItem, type PosEvent } from '@pos/events';
import { buildReceipt } from '../src';

const T0 = Date.parse('2026-10-01T12:00:00+07:00');
const MIN = 60_000;

function events(...list: [number, EventBody][]): PosEvent[] {
  const c = new EventChain('term-1', 'o1');
  return list.map(([min, body]) => c.append({ ...body, deviceTime: T0 + min * MIN, actorId: 'budi' }));
}
const kopi = (qty: number): LineItem => ({ itemId: 'kopi', name: 'Kopi', qty, unitPrice: 22_000 });
const matcha: LineItem = { itemId: 'matcha', name: 'Matcha', qty: 1, unitPrice: 34_000, options: [{ group: 'Ukuran', name: 'Large', price: 6_000 }] };
const created = (id: string, table?: string): [number, EventBody] => [0, { type: 'order.created', payload: { orderId: id, orderType: 'DINE_IN', ...(table ? { tableNo: table } : {}) } }];

describe('struk digital', () => {
  it('order lunas: item, opsi, subtotal, diskon, pajak, total, dan pembayaran per metode', () => {
    const ev = events(
      created('term-1-7', '5'),
      [5, { type: 'discount.applied', payload: { orderId: 'term-1-7', kind: 'MEMBER', amount: 8_000, percent: 10, verified: true } }],
      // subtotal 2×22.000 + 34.000 = 78.000; diskon 8.000 → 70.000; PBJT 10% = 7.000; total 77.000
      [10, { type: 'bill.printed', payload: { orderId: 'term-1-7', total: 77_000, items: [kopi(2), matcha] } }],
      [12, { type: 'payment.received', payload: { orderId: 'term-1-7', method: 'CASH', amount: 30_000 } }],
      [13, { type: 'payment.received', payload: { orderId: 'term-1-7', method: 'QRIS', amount: 47_000, tid: '12345678', approvalCode: '998877' } }],
    );
    const r = buildReceipt('term-1-7', ev)!;
    expect(r).toMatchObject({
      ref: '7', type: 'DINE_IN', table: '5', status: 'PAID', subtotal: 78_000, discount: 8_000, tax: 7_000, total: 77_000, paid: 77_000, refunded: 0,
      issuedAt: T0 + 10 * MIN, voidedAt: null, noItems: false,
    });
    expect(r.items).toEqual([
      { name: 'Kopi', options: [], qty: 2, unitPrice: 22_000, amount: 44_000 },
      { name: 'Matcha', options: ['Large'], qty: 1, unitPrice: 34_000, amount: 34_000 },
    ]);
    expect(r.payments.map((p) => [p.method, p.amount])).toEqual([['CASH', 30_000], ['QRIS', 47_000]]);
  });

  it('tanpa data pribadi: tidak ada kasir, TID, kode approval, atau id order lengkap di hasilnya', () => {
    const ev = events(
      created('term-1-7'),
      [1, { type: 'bill.printed', payload: { orderId: 'term-1-7', total: 24_200, items: [kopi(1)] } }],
      [2, { type: 'payment.received', payload: { orderId: 'term-1-7', method: 'EDC_DEBIT', amount: 24_200, tid: '12345678', approvalCode: '998877' } }],
    );
    const json = JSON.stringify(buildReceipt('term-1-7', ev));
    for (const secret of ['budi', '12345678', '998877', 'term-1-7', 'actor']) expect(json).not.toContain(secret);
  });

  it('status: belum dibayar, sebagian, lunas, dibatalkan (void menang walau sudah dibayar)', () => {
    const base = [created('o-1'), [1, { type: 'bill.printed', payload: { orderId: 'o-1', total: 24_200, items: [kopi(1)] } }] as [number, EventBody]];
    expect(buildReceipt('o-1', events(...base))!.status).toBe('UNPAID');
    const part = events(...base, [2, { type: 'payment.received', payload: { orderId: 'o-1', method: 'CASH', amount: 10_000 } }]);
    expect(buildReceipt('o-1', part)).toMatchObject({ status: 'PARTIAL', paid: 10_000 });
    const full = events(...base, [2, { type: 'payment.received', payload: { orderId: 'o-1', method: 'CASH', amount: 24_200 } }]);
    expect(buildReceipt('o-1', full)!.status).toBe('PAID');
    const voided = events(...base, [2, { type: 'payment.received', payload: { orderId: 'o-1', method: 'CASH', amount: 24_200 } }],
      [9, { type: 'void.approved', payload: { orderId: 'o-1', reasonCode: 'WRONG_ORDER', approverIds: ['hendra'], amount: 24_200 } }]);
    expect(buildReceipt('o-1', voided)).toMatchObject({ status: 'VOIDED', voidedAt: T0 + 9 * MIN, paid: 24_200 });
  });

  it('refund dihitung; bill dicetak ulang memakai yang terakhir; pindah meja memakai meja terakhir', () => {
    const ev = events(
      created('o-1', '3'),
      [1, { type: 'bill.printed', payload: { orderId: 'o-1', total: 24_200, items: [kopi(1)] } }],
      [2, { type: 'bill.printed', payload: { orderId: 'o-1', total: 48_400, items: [kopi(2)] } }],
      [3, { type: 'order.table_changed', payload: { orderId: 'o-1', from: '3', to: '9' } }],
      [4, { type: 'payment.received', payload: { orderId: 'o-1', method: 'CASH', amount: 48_400 } }],
      [5, { type: 'refund.created', payload: { refundId: 'o-1-R1', originalOrderId: 'o-1', amount: 10_000, method: 'CASH', approverId: 'hendra' } }],
    );
    expect(buildReceipt('o-1', ev)).toMatchObject({ table: '9', total: 48_400, subtotal: 44_000, tax: 4_400, refunded: 10_000, status: 'PAID' });
  });

  it('event order lain tidak ikut; order tidak dikenal null; tagihan dari terminal lama tanpa item ditandai noItems', () => {
    const ev = events(
      created('o-1'), created('o-2'),
      [1, { type: 'bill.printed', payload: { orderId: 'o-1', total: 10_000 } }],
      [1, { type: 'bill.printed', payload: { orderId: 'o-2', total: 99_000, items: [kopi(9)] } }],
      [2, { type: 'payment.received', payload: { orderId: 'o-1', method: 'CASH', amount: 10_000 } }],
    );
    expect(buildReceipt('o-1', ev)).toMatchObject({ noItems: true, items: [], total: 10_000, tax: 0, status: 'PAID' });
    expect(buildReceipt('tidak-ada', ev)).toBeNull();
  });
});
