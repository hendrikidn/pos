import { describe, expect, it } from 'vitest';
import { EventChain, type EventBody, type PosEvent } from '@pos/events';
import { buildTableBoard, formatTableList, parseTableList, summarizeTable, TABLE_ORDER_MAX_IDLE_MS } from '../src';

const T0 = Date.parse('2026-10-01T12:00:00+07:00');
const MIN = 60_000;

class Rec {
  readonly events: PosEvent[] = [];
  private readonly chains = new Map<string, EventChain>();
  at(min: number, body: EventBody, device = 'term-1'): void {
    let c = this.chains.get(device);
    if (!c) this.chains.set(device, (c = new EventChain(device, 'o1')));
    this.events.push(c.append({ ...body, deviceTime: T0 + min * MIN, actorId: null }));
  }
  created(min: number, orderId: string, tableNo?: string, device = 'term-1', type: 'DINE_IN' | 'TAKE_AWAY' = 'DINE_IN') {
    this.at(min, { type: 'order.created', payload: { orderId, orderType: type, ...(tableNo ? { tableNo } : {}) } }, device);
  }
}
const board = (r: Rec, min: number) => buildTableBoard({ events: r.events, now: T0 + min * MIN });

describe('papan meja', () => {
  it('order dine-in terbuka muncul di mejanya dengan terminal asal; take-away dan tanpa meja tidak', () => {
    const r = new Rec();
    r.created(0, 'a-1', '5');
    r.created(1, 'b-1', '7', 'term-2');
    r.created(2, 'a-2', '6', 'term-1', 'TAKE_AWAY');
    r.created(3, 'a-3');
    const b = board(r, 5);
    expect(b.orders.map((o) => [o.orderId, o.deviceId, o.tableNo, o.status])).toEqual([
      ['a-1', 'term-1', '5', 'DRAFT'], ['b-1', 'term-2', '7', 'DRAFT'],
    ]);
  });

  it('status mengikuti dapur dan bill; meja bebas lagi setelah lunas, void, atau digabung', () => {
    const r = new Rec();
    for (const [id, tb] of [['a-1', '1'], ['a-2', '2'], ['a-3', '3'], ['a-4', '4']] as const) r.created(0, id, tb);
    r.at(1, { type: 'order.sent_to_kitchen', payload: { orderId: 'a-1' } });
    r.at(1, { type: 'bill.printed', payload: { orderId: 'a-2', total: 50_000 } });
    r.at(2, { type: 'bill.printed', payload: { orderId: 'a-3', total: 30_000 } });
    r.at(3, { type: 'payment.received', payload: { orderId: 'a-3', method: 'CASH', amount: 30_000 } });
    r.at(3, { type: 'void.approved', payload: { orderId: 'a-4', approverIds: ['s'], reasonCode: 'WRONG_ORDER', amount: 0 } });
    expect(board(r, 5).orders.map((o) => `${o.tableNo}:${o.status}`)).toEqual(['1:SENT', '2:BILLED']);
    r.created(4, 'a-5', '1');
    r.at(5, { type: 'order.items_moved', payload: { fromOrderId: 'a-5', toOrderId: 'a-1', kind: 'MERGE', items: [], sent: false } });
    expect(board(r, 6).orders.map((o) => o.orderId)).toEqual(['a-1', 'a-2']);
  });

  it('pembayaran sebagian menahan meja; sisa tagihan dihitung', () => {
    const r = new Rec();
    r.created(0, 'a-1', '8');
    r.at(1, { type: 'bill.printed', payload: { orderId: 'a-1', total: 90_000 } });
    r.at(2, { type: 'payment.received', payload: { orderId: 'a-1', method: 'QRIS', amount: 30_000 } });
    const b = board(r, 3);
    expect(b.orders).toHaveLength(1);
    expect(summarizeTable('8', b.orders)).toMatchObject({ state: 'BILLED', due: 60_000, since: T0 });
  });

  it('pindah meja memindahkan order; order lama yang tak tersentuh lama tidak menahan meja', () => {
    const r = new Rec();
    r.created(0, 'a-1', '2');
    r.at(1, { type: 'order.table_changed', payload: { orderId: 'a-1', from: '2', to: '9' } });
    expect(board(r, 2).orders.map((o) => o.tableNo)).toEqual(['9']);
    expect(buildTableBoard({ events: r.events, now: T0 + MIN + TABLE_ORDER_MAX_IDLE_MS + 1 }).orders).toEqual([]);
  });

  it('beberapa order di satu meja (pisah bill): status terjauh, jumlah order, waktu tertua', () => {
    const r = new Rec();
    r.created(0, 'a-1', '4');
    r.created(10, 'b-1', '4', 'term-2');
    r.at(11, { type: 'bill.printed', payload: { orderId: 'b-1', total: 20_000 } }, 'term-2');
    const s = summarizeTable('4', board(r, 12).orders);
    expect(s).toMatchObject({ state: 'BILLED', since: T0, due: 20_000 });
    expect(s.orders).toHaveLength(2);
    expect(summarizeTable('5', board(r, 12).orders)).toMatchObject({ state: 'FREE', since: null, due: 0, orders: [] });
  });
});

describe('daftar nomor meja dari teks', () => {
  it('rentang, daftar, dan nama dengan huruf; nomor kembar dibuang; urutan dipertahankan', () => {
    expect(parseTableList('1-4, 7, T1 T2')).toEqual(['1', '2', '3', '4', '7', 'T1', 'T2']);
    expect(parseTableList('3, 1-3')).toEqual(['3', '1', '2']);
    expect(parseTableList('')).toEqual([]);
  });
  it('menolak bagian tidak valid, rentang terbalik atau terlalu besar, dan lebih dari 200 meja', () => {
    expect(parseTableList('1-3, meja#1')).toBeNull();
    expect(parseTableList('5-2')).toBeNull();
    expect(parseTableList('1-9999')).toBeNull();
    expect(parseTableList('abc!')).toBeNull();
    expect(parseTableList('1-150, 301-400')).toBeNull();
  });
  it('format meringkas tiga angka berurutan atau lebih dan kembali ke daftar yang sama', () => {
    expect(formatTableList(['1', '2', '3', '4', '7', '9', '10', 'T1'])).toBe('1-4, 7, 9, 10, T1');
    for (const nos of [['1', '2', '3', '5'], ['T1', 'T2', 'T3'], ['8', '9'], ['10', '11', '12', '13', 'A']]) {
      expect(parseTableList(formatTableList(nos))).toEqual(nos);
    }
  });
});
