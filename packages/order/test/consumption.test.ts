import { describe, expect, it } from 'vitest';
import { EventChain, type EventBody, type LineItem, type PosEvent } from '@pos/events';
import { consumptionByOrder, usageByIngredient, type Recipes } from '../src';

const T0 = Date.parse('2026-10-01T12:00:00+07:00');
const MIN = 60_000;

class Rec {
  readonly events: PosEvent[] = [];
  private readonly c = new EventChain('term-1', 'o1');
  at(min: number, body: EventBody) { this.events.push(this.c.append({ ...body, deviceTime: T0 + min * MIN, actorId: null })); }
  created(min: number, id: string, type: 'DINE_IN' | 'EMPLOYEE' = 'DINE_IN') { this.at(min, { type: 'order.created', payload: { orderId: id, orderType: type } }); }
  sent(min: number, id: string, items?: LineItem[]) { this.at(min, { type: 'order.sent_to_kitchen', payload: { orderId: id, ...(items ? { items } : {}) } }); }
  bill(min: number, id: string, items?: LineItem[]) { this.at(min, { type: 'bill.printed', payload: { orderId: id, total: 1, ...(items ? { items } : {}) } }); }
  void(min: number, id: string) { this.at(min, { type: 'void.approved', payload: { orderId: id, reasonCode: 'WRONG_ORDER', approverIds: ['h'], amount: 1 } }); }
}
const kopi = (qty: number, extra: Partial<LineItem> = {}): LineItem => ({ itemId: 'kopi', name: 'Kopi', qty, unitPrice: 22_000, ...extra });
const summary = (r: Rec) => consumptionByOrder(r.events).map((c) => `${c.orderId}@${(c.at - T0) / MIN}:${c.items.map((i) => `${i.qty}x${i.itemId}`).join('+')}`);

describe('pemakaian bahan per order', () => {
  it('order ditagih memakai isi tagihan terakhir pada waktu tagihan; draf belum memakai apa pun', () => {
    const r = new Rec();
    r.created(0, 'a'); r.sent(1, 'a', [kopi(1)]); r.bill(5, 'a', [kopi(2)]);
    r.created(0, 'draf'); // tidak dikirim, tidak ditagih
    expect(summary(r)).toEqual(['a@5:2xkopi']);
  });

  it('tanpa tagihan: item yang dikirim ke dapur dijumlahkan (kiriman susulan ikut)', () => {
    const r = new Rec();
    r.created(0, 'a'); r.sent(1, 'a', [kopi(1)]); r.sent(4, 'a', [kopi(2)]);
    expect(summary(r)).toEqual(['a@4:3xkopi']);
  });

  it('di-void SESUDAH dikirim: bahan sudah terpakai (item terkirim); di-void SEBELUM dikirim: tidak ada pemakaian', () => {
    const r = new Rec();
    r.created(0, 'a'); r.sent(1, 'a', [kopi(2)]); r.bill(3, 'a', [kopi(2)]); r.void(6, 'a');
    r.created(0, 'b'); r.bill(2, 'b', [kopi(5)]); r.void(3, 'b');
    expect(summary(r)).toEqual(['a@1:2xkopi']);
  });

  it('makan karyawan memakai bahan; order yang digabung ke order lain tidak (itemnya sudah di tagihan tujuan)', () => {
    const r = new Rec();
    r.created(0, 'm', 'EMPLOYEE'); r.sent(1, 'm', [kopi(1)]);
    r.created(0, 'x'); r.sent(1, 'x', [kopi(2)]);
    r.created(0, 'y'); r.bill(5, 'y', [kopi(3)]);
    r.at(4, { type: 'order.items_moved', payload: { fromOrderId: 'x', toOrderId: 'y', kind: 'MERGE', items: [kopi(2, { sentQty: 2 })], sent: true } });
    expect(summary(r)).toEqual(['m@1:1xkopi', 'y@5:3xkopi']);
  });

  it('event terminal lama tanpa rincian item tidak menghasilkan pemakaian', () => {
    const r = new Rec();
    r.created(0, 'a'); r.sent(1, 'a'); r.bill(2, 'a');
    expect(summary(r)).toEqual([]);
  });
});

describe('pemakaian bahan dari resep', () => {
  const recipes: Recipes = {
    base: new Map([['kopi', new Map([['biji', 18], ['susu', 150]])], ['matcha', new Map([['bubuk', 5]])]]),
    options: new Map([['matcha|oat', new Map([['oat', 200]])], ['kopi|shot', new Map([['biji', 9]])]]),
  };
  const c = (id: string, min: number, items: LineItem[]) => ({ orderId: id, at: T0 + min * MIN, items });

  it('porsi × resep dasar + resep opsi yang dipilih (berdasarkan id opsi)', () => {
    const used = usageByIngredient([
      c('a', 5, [kopi(2, { options: [{ id: 'shot', group: 'Tambahan', name: 'Extra shot', price: 5_000 }] })]),
      c('b', 6, [{ itemId: 'matcha', name: 'Matcha', qty: 3, unitPrice: 1, options: [{ id: 'oat', group: 'Topping', name: 'Oat', price: 8_000 }] }]),
    ], recipes, T0, T0 + 60 * MIN);
    // kopi ×2: biji 2×(18+9)=54, susu 2×150=300; matcha ×3: bubuk 15, oat 600
    expect(Object.fromEntries(used)).toEqual({ biji: 54, susu: 300, bubuk: 15, oat: 600 });
  });

  it('rentang waktu (dari, sampai]: batas awal tidak ikut, batas akhir ikut', () => {
    const list = [c('a', 5, [kopi(1)]), c('b', 10, [kopi(1)]), c('c', 15, [kopi(1)])];
    expect(usageByIngredient(list, recipes, T0 + 5 * MIN, T0 + 15 * MIN).get('biji')).toBe(36);
  });

  it('menu tanpa resep, opsi tanpa id (event lama), dan opsi tanpa resep tidak memakai bahan tambahan', () => {
    const used = usageByIngredient([c('a', 5, [{ itemId: 'teh', name: 'Teh', qty: 4, unitPrice: 1 }, kopi(1, { options: [{ group: 'Tambahan', name: 'Extra shot', price: 1 }, { id: 'tidak-ada', group: 'X', name: 'Y', price: 0 }] })])], recipes, T0, T0 + 60 * MIN);
    expect(Object.fromEntries(used)).toEqual({ biji: 18, susu: 150 });
  });
});
