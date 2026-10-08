import { describe, expect, it } from 'vitest';
import { EventChain, type EventBody, type KitchenStatus, type LineItem, type PosEvent } from '@pos/events';
import { buildKitchenBoard, KDS_HISTORY_MS, KDS_VOID_VISIBLE_MS } from '../src';

const T0 = Date.parse('2026-10-01T12:00:00+07:00');
const MIN = 60_000;

/** Penyusun event: satu rantai per perangkat, waktu dalam menit sejak T0. */
class Rec {
  readonly events: PosEvent[] = [];
  private readonly chains = new Map<string, EventChain>();
  at(min: number, body: EventBody, device = 'term-1'): void {
    let c = this.chains.get(device);
    if (!c) this.chains.set(device, (c = new EventChain(device, 'o1')));
    this.events.push(c.append({ ...body, deviceTime: T0 + min * MIN, actorId: null }));
  }
  created(min: number, orderId: string, type: 'DINE_IN' | 'TAKE_AWAY' = 'DINE_IN', tableNo?: string) {
    this.at(min, { type: 'order.created', payload: { orderId, orderType: type, ...(tableNo ? { tableNo } : {}) } });
  }
  sent(min: number, orderId: string, items?: LineItem[]) {
    this.at(min, { type: 'order.sent_to_kitchen', payload: { orderId, ...(items ? { items } : {}) } });
  }
  status(min: number, orderId: string, status: KitchenStatus, device = 'term-1') {
    this.at(min, { type: 'kitchen.status_changed', payload: { orderId, status } }, device);
  }
}
const item = (itemId: string, name: string, qty: number, extra: Partial<LineItem> = {}): LineItem => ({ itemId, name, qty, unitPrice: 20_000, ...extra });
const board = (r: Rec, nowMin: number) => buildKitchenBoard({ events: r.events, now: T0 + nowMin * MIN });
const summary = (b: ReturnType<typeof board>) =>
  b.tickets.map((t) => `${t.ref}:${t.status}:${t.lines.map((l) => `${l.qty}x${l.name}${l.fresh ? '*' : ''}`).join('+')}`);

describe('papan dapur: dasar', () => {
  it('tiket memuat item yang sudah dikirim dengan opsi, catatan, meja, dan nomor tampilan; status awal NEW', () => {
    const r = new Rec();
    r.created(0, 'term-1-12', 'DINE_IN', '5');
    r.sent(1, 'term-1-12', [item('matcha', 'Matcha', 2, { options: [{ group: 'Ukuran', name: 'Large', price: 6_000 }], note: 'es sedikit' }), item('kopi', 'Kopi', 1)]);
    const b = board(r, 3);
    expect(b.tickets).toHaveLength(1);
    expect(b.tickets[0]).toMatchObject({
      orderId: 'term-1-12', ref: '12', type: 'DINE_IN', table: '5', status: 'NEW', hasNew: false, firstSentAt: T0 + MIN, noDetail: false,
      lines: [
        { name: 'Matcha', options: ['Large'], note: 'es sedikit', qty: 2, fresh: false },
        { name: 'Kopi', options: [], qty: 1, fresh: false },
      ],
    });
  });

  it('order yang belum dikirim ke dapur tidak muncul', () => {
    const r = new Rec();
    r.created(0, 'term-1-1', 'TAKE_AWAY');
    expect(board(r, 5).tickets).toEqual([]);
  });

  it('alur status: COOKING dan READY tetap di papan, SERVED menutup tiket', () => {
    const r = new Rec();
    r.created(0, 'term-1-1'); r.sent(1, 'term-1-1', [item('k', 'Kopi', 1)]);
    expect(summary(board(r, 2))).toEqual(['1:NEW:1xKopi']);
    r.status(3, 'term-1-1', 'COOKING');
    expect(summary(board(r, 4))).toEqual(['1:COOKING:1xKopi']);
    r.status(6, 'term-1-1', 'READY');
    expect(summary(board(r, 7))).toEqual(['1:READY:1xKopi']);
    r.status(8, 'term-1-1', 'SERVED');
    expect(board(r, 9).tickets).toEqual([]);
  });

  it('status dari perangkat lain (layar dapur) berlaku sama; urutan array event tidak berpengaruh', () => {
    const r = new Rec();
    r.created(0, 'term-1-1'); r.sent(1, 'term-1-1', [item('k', 'Kopi', 1)]);
    r.status(3, 'term-1-1', 'COOKING', 'kds-1');
    const shuffled = { events: [...r.events].reverse(), now: T0 + 4 * MIN };
    expect(buildKitchenBoard(shuffled).tickets.map((t) => t.status)).toEqual(['COOKING']);
  });

  it('tiket diurutkan dari yang paling lama menunggu', () => {
    const r = new Rec();
    r.created(0, 'term-1-1'); r.created(0, 'term-1-2'); r.created(0, 'term-1-3');
    r.sent(5, 'term-1-2', [item('a', 'A', 1)]); r.sent(2, 'term-1-3', [item('b', 'B', 1)]); r.sent(9, 'term-1-1', [item('c', 'C', 1)]);
    expect(board(r, 10).tickets.map((t) => t.ref)).toEqual(['3', '2', '1']);
  });

  it('pindah meja mengubah meja di tiket', () => {
    const r = new Rec();
    r.created(0, 'term-1-1', 'DINE_IN', '5'); r.sent(1, 'term-1-1', [item('k', 'Kopi', 1)]);
    r.at(2, { type: 'order.table_changed', payload: { orderId: 'term-1-1', from: '5', to: '12' } });
    expect(board(r, 3).tickets[0]!.table).toBe('12');
  });

  it('tiket dari terminal lama (tanpa rincian item) tetap tampil dengan penanda', () => {
    const r = new Rec();
    r.created(0, 'term-1-1'); r.sent(1, 'term-1-1');
    expect(board(r, 2).tickets[0]).toMatchObject({ noDetail: true, lines: [] });
  });

  it('tiket lebih tua dari 12 jam tidak ditampilkan', () => {
    const r = new Rec();
    r.created(0, 'term-1-1'); r.sent(1, 'term-1-1', [item('k', 'Kopi', 1)]);
    expect(board(r, KDS_HISTORY_MS / MIN).tickets).toHaveLength(1);
    expect(board(r, KDS_HISTORY_MS / MIN + 2).tickets).toEqual([]);
  });
});

describe('papan dapur: item susulan', () => {
  it('item yang sama dijumlahkan; item susulan saat COOKING ditandai fresh dan tiket hasNew', () => {
    const r = new Rec();
    r.created(0, 'term-1-1'); r.sent(1, 'term-1-1', [item('k', 'Kopi', 2)]);
    r.status(2, 'term-1-1', 'COOKING');
    r.sent(4, 'term-1-1', [item('k', 'Kopi', 1), item('l', 'Latte', 1)]);
    const t = board(r, 5).tickets[0]!;
    expect(t).toMatchObject({ status: 'COOKING', hasNew: true });
    expect(summary(board(r, 5))).toEqual(['1:COOKING:3xKopi*+1xLatte*']); // Kopi gabungan dihitung fresh karena penambahan terakhir
    r.status(6, 'term-1-1', 'COOKING');
    expect(board(r, 7).tickets[0]!.hasNew).toBe(false);
  });

  it('item susulan saat tiket READY: status kembali COOKING agar dapur menyentuhnya lagi', () => {
    const r = new Rec();
    r.created(0, 'term-1-1'); r.sent(1, 'term-1-1', [item('k', 'Kopi', 1)]);
    r.status(5, 'term-1-1', 'READY');
    r.sent(6, 'term-1-1', [item('l', 'Latte', 1)]);
    const t = board(r, 7).tickets[0]!;
    expect(t.status).toBe('COOKING');
    expect(t.lines.map((l) => [l.name, l.fresh])).toEqual([['Kopi', false], ['Latte', true]]);
  });

  it('item susulan sesudah SERVED membuka tiket baru berisi yang baru saja; waktu tunggu mulai lagi', () => {
    const r = new Rec();
    r.created(0, 'term-1-1'); r.sent(1, 'term-1-1', [item('k', 'Kopi', 1)]);
    r.status(5, 'term-1-1', 'SERVED');
    r.sent(20, 'term-1-1', [item('l', 'Latte', 1)]);
    const t = board(r, 21).tickets[0]!;
    expect(t).toMatchObject({ status: 'NEW', firstSentAt: T0 + 20 * MIN });
    expect(summary(board(r, 21))).toEqual(['1:NEW:1xLatte']);
  });
});

describe('papan dapur: void', () => {
  it('order yang di-void keluar dari tiket dan muncul di daftar batal selama 15 menit', () => {
    const r = new Rec();
    r.created(0, 'term-1-1', 'DINE_IN', '3'); r.sent(1, 'term-1-1', [item('k', 'Kopi', 2)]);
    r.status(2, 'term-1-1', 'COOKING');
    r.at(4, { type: 'void.approved', payload: { orderId: 'term-1-1', reasonCode: 'WRONG_ORDER', approverIds: ['hendra'], amount: 40_000 } });
    const b = board(r, 5);
    expect(b.tickets).toEqual([]);
    expect(b.voided).toMatchObject([{ orderId: 'term-1-1', ref: '1', table: '3', at: T0 + 4 * MIN, lines: [{ name: 'Kopi', qty: 2 }] }]);
    expect(board(r, 4 + KDS_VOID_VISIBLE_MS / MIN + 1).voided).toEqual([]);
  });

  it('void sebelum dikirim ke dapur tidak menghasilkan apa pun', () => {
    const r = new Rec();
    r.created(0, 'term-1-1');
    r.at(1, { type: 'void.approved', payload: { orderId: 'term-1-1', reasonCode: 'WRONG_ORDER', approverIds: [], amount: 0 } });
    const b = board(r, 2);
    expect(b.tickets).toEqual([]);
    expect(b.voided).toEqual([]);
  });
});

describe('papan dapur: pisah bill dan gabung', () => {
  const split = (r: Rec, min: number, items: LineItem[], kitchen?: KitchenStatus) => {
    r.created(min, 'term-1-2', 'DINE_IN', '5');
    r.at(min, { type: 'order.items_moved', payload: { fromOrderId: 'term-1-1', toOrderId: 'term-1-2', kind: 'SPLIT', items, sent: items.some((i) => (i.sentQty ?? 0) > 0), ...(kitchen ? { kitchen } : {}) } });
  };

  it('hanya bagian yang sudah terkirim yang pindah; waktu tunggu dan status ikut; asal berkurang', () => {
    const r = new Rec();
    r.created(0, 'term-1-1', 'DINE_IN', '5');
    r.sent(1, 'term-1-1', [item('k', 'Kopi', 3)]);
    r.status(2, 'term-1-1', 'COOKING');
    // 2 kopi dipindah: 1 sudah terkirim, 1 belum (belum ada di papan)
    split(r, 4, [item('k', 'Kopi', 2, { sentQty: 1 })], 'COOKING');
    const b = board(r, 5);
    expect(summary(b)).toEqual(['1:COOKING:2xKopi', '2:COOKING:1xKopi']);
    const dest = b.tickets.find((t) => t.ref === '2')!;
    expect(dest).toMatchObject({ table: '5', firstSentAt: T0 + MIN, statusAt: T0 + 2 * MIN });
  });

  it('status dapur yang diubah dari layar dapur ikut ke tiket baru walau event pemisahan tidak memuatnya (terminal tidak tahu)', () => {
    const r = new Rec();
    r.created(0, 'term-1-1', 'DINE_IN', '5'); r.sent(1, 'term-1-1', [item('k', 'Kopi', 2)]);
    r.status(2, 'term-1-1', 'READY', 'kds-1');
    split(r, 4, [item('k', 'Kopi', 1, { sentQty: 1 })]); // tanpa `kitchen`
    const dest = board(r, 5).tickets.find((t) => t.ref === '2')!;
    expect(dest).toMatchObject({ status: 'READY', statusAt: T0 + 2 * MIN, firstSentAt: T0 + MIN });
  });

  it('pemisahan yang hanya memindahkan item belum terkirim tidak membuat tiket baru', () => {
    const r = new Rec();
    r.created(0, 'term-1-1', 'DINE_IN', '5'); r.sent(1, 'term-1-1', [item('k', 'Kopi', 1)]);
    split(r, 4, [item('l', 'Latte', 1, { sentQty: 0 })]);
    expect(summary(board(r, 5))).toEqual(['1:NEW:1xKopi']);
  });

  it('seluruh item terkirim dipindah: tiket asal hilang, tiket baru menggantikannya', () => {
    const r = new Rec();
    r.created(0, 'term-1-1', 'DINE_IN', '5'); r.sent(1, 'term-1-1', [item('k', 'Kopi', 1)]);
    split(r, 4, [item('k', 'Kopi', 1, { sentQty: 1 })]);
    expect(summary(board(r, 5))).toEqual(['2:NEW:1xKopi']);
  });

  it('gabung: item pindah ke tujuan, tiket asal hilang, status mengikuti asal bila tujuan masih NEW, waktu tunggu terlama', () => {
    const r = new Rec();
    r.created(0, 'term-1-1'); r.created(0, 'term-1-2');
    r.sent(2, 'term-1-1', [item('k', 'Kopi', 1)]);          // tujuan: NEW, dikirim menit 2
    r.sent(1, 'term-1-2', [item('k', 'Kopi', 1), item('l', 'Latte', 1)]); // asal: dikirim menit 1
    r.status(3, 'term-1-2', 'COOKING');
    r.at(5, { type: 'order.items_moved', payload: { fromOrderId: 'term-1-2', toOrderId: 'term-1-1', kind: 'MERGE', items: [item('k', 'Kopi', 1, { sentQty: 1 })], sent: true, kitchen: 'COOKING' } });
    const b = board(r, 6);
    expect(summary(b)).toEqual(['1:COOKING:2xKopi+1xLatte']);
    expect(b.tickets[0]).toMatchObject({ firstSentAt: T0 + MIN, statusAt: T0 + 3 * MIN });
  });
});

describe('papan dapur: daftar order yang sudah disajikan', () => {
  it('SERVED masuk daftar (agar terminal tahu); kiriman berikutnya membuka kembali tiket dan mengeluarkannya dari daftar', () => {
    const r = new Rec();
    r.created(0, 'term-1-1'); r.sent(1, 'term-1-1', [item('k', 'Kopi', 1)]);
    expect(board(r, 2).served).toEqual([]);
    r.status(3, 'term-1-1', 'SERVED');
    expect(board(r, 4).served).toEqual(['term-1-1']);
    expect(board(r, 4).tickets).toEqual([]);
    r.sent(10, 'term-1-1', [item('l', 'Latte', 1)]);
    expect(board(r, 11).served).toEqual([]);
  });

  it('order yang di-void atau sudah lewat 12 jam tidak ada di daftar', () => {
    const r = new Rec();
    r.created(0, 'term-1-1'); r.sent(1, 'term-1-1', [item('k', 'Kopi', 1)]); r.status(2, 'term-1-1', 'SERVED');
    r.created(0, 'term-1-2'); r.sent(1, 'term-1-2', [item('k', 'Kopi', 1)]); r.status(2, 'term-1-2', 'SERVED');
    r.at(3, { type: 'void.approved', payload: { orderId: 'term-1-2', reasonCode: 'WRONG_ORDER', approverIds: ['hendra'], amount: 1 } });
    expect(board(r, 5).served).toEqual(['term-1-1']);
    expect(board(r, 2 + KDS_HISTORY_MS / MIN + 1).served).toEqual([]);
  });
});

