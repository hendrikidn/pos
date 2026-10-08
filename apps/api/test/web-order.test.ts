import { describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import type { ModifierGroup } from '@pos/order';
import { checkCart, LINK_GRACE_MS, UNPAID_AFTER_MS, webOrderHits, type MenuRow, type WebOrderFacts } from '../src/web-order';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const SIZE: ModifierGroup = { id: 'size', name: 'Ukuran', min: 1, max: 1, options: [{ id: 'reg', name: 'Regular', price: 0 }, { id: 'lrg', name: 'Large', price: 5000 }] };
const TOP: ModifierGroup = { id: 'top', name: 'Topping', min: 0, max: 2, options: [{ id: 'boba', name: 'Boba', price: 6000 }, { id: 'oat', name: 'Oat', price: 8000 }] };
const menu = new Map<string, MenuRow>([
  ['kopi', { id: 'kopi', name: 'Kopi Susu', price: 22_000, modifierGroups: [] }],
  ['teh', { id: 'teh', name: 'Teh', price: 15_000, modifierGroups: [SIZE, TOP] }],
]);

describe('toko web: keranjang pelanggan', () => {
  it('harga dan nama dari menu server; opsi menambah harga; baris yang sama digabung', () => {
    const r = checkCart([
      { itemId: 'kopi', qty: 1, unitPrice: 1 }, // harga kiriman pelanggan diabaikan
      { itemId: 'kopi', qty: 2 },
      { itemId: 'teh', qty: 1, options: ['lrg', 'boba'], note: ' less ice ' },
    ], menu);
    expect(r).toEqual({
      ok: true,
      lines: [
        { itemId: 'kopi', name: 'Kopi Susu', qty: 3, unitPrice: 22_000, options: [] },
        { itemId: 'teh', name: 'Teh', qty: 1, unitPrice: 26_000, note: 'less ice', options: [expect.objectContaining({ optionId: 'lrg' }), expect.objectContaining({ optionId: 'boba' })] },
      ],
    });
  });

  it('menolak: kosong, terlalu banyak baris, menu tidak ada, jumlah, opsi wajib/tak dikenal/kelebihan, catatan panjang', () => {
    const bad = (items: unknown) => { const r = checkCart(items, menu); return r.ok ? 'OK' : r.message; };
    expect(bad([])).toContain('kosong');
    expect(bad('x')).toContain('kosong');
    expect(bad(Array.from({ length: 31 }, () => ({ itemId: 'kopi', qty: 1 })))).toContain('maksimal 30');
    expect(bad([{ itemId: 'hantu', qty: 1 }])).toContain('tidak tersedia');
    expect(bad([{ itemId: 'kopi', qty: 0 }])).toContain('jumlah');
    expect(bad([{ itemId: 'kopi', qty: 21 }])).toContain('jumlah');
    expect(bad([{ itemId: 'kopi', qty: 1.5 }])).toContain('jumlah');
    expect(bad([{ itemId: 'kopi', qty: 11 }, { itemId: 'kopi', qty: 11 }])).toContain('maksimal 20'); // digabung melebihi batas
    expect(bad([{ itemId: 'teh', qty: 1 }])).toContain('Teh'); // ukuran wajib
    expect(bad([{ itemId: 'teh', qty: 1, options: ['lrg', 'nggak-ada'] }])).toContain('Teh');
    expect(bad([{ itemId: 'teh', qty: 1, options: ['lrg', 'reg'] }])).toContain('Teh'); // dua ukuran
    expect(bad([{ itemId: 'kopi', qty: 1, note: 'x'.repeat(141) }])).toContain('catatan');
    expect(bad([{ itemId: 'kopi', qty: 1, options: 'lrg' }])).toContain('pilihan');
  });
});

describe('toko web: temuan R45-R47 (murni)', () => {
  const T = WIB('2026-10-08T12:00:00');
  const accepted = (id: number, total = 50_000, at = T): WebOrderFacts => ({ id, status: 'ACCEPTED', estimatedTotal: total, decidedAtMs: at });
  function events(build: (s: Sim) => void) {
    const s = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1');
    build(s);
    return s.events;
  }
  const link = (s: Sim, order: string, web: number, at: number) => {
    s.pos({ type: 'order.created', payload: { orderId: order, orderType: 'TAKE_AWAY' } }, at, 'budi');
    s.pos({ type: 'order.web_linked', payload: { orderId: order, webOrderId: web } }, at + 1000, 'budi');
  };
  const pay = (s: Sim, order: string, amount: number, at: number) => s.pos({ type: 'payment.received', payload: { orderId: order, method: 'CASH', amount } }, at, 'budi');
  const rules = (h: { rule: string }[]) => h.map((x) => x.rule).sort();

  it('pesanan yang ditautkan dan dibayar sesuai nilainya tidak menimbulkan temuan', () => {
    const ev = events((s) => { link(s, 'a', 1, T + 60_000); pay(s, 'a', 50_000, T + 600_000); });
    expect(webOrderHits([accepted(1)], ev, T + 4 * 3_600_000, 0)).toEqual([]);
    const tolerant = events((s) => { link(s, 'a', 1, T + 60_000); pay(s, 'a', 46_000, T + 600_000); }); // selisih kecil (≤10%) wajar
    expect(webOrderHits([accepted(1)], tolerant, T + 4 * 3_600_000, 0)).toEqual([]);
  });

  it('R45: diterima tetapi tidak pernah jadi order; baru setelah 15 menit', () => {
    expect(webOrderHits([accepted(1)], [], T + LINK_GRACE_MS - 1, 0)).toEqual([]);
    const h = webOrderHits([accepted(1)], [], T + LINK_GRACE_MS, 0);
    expect(rules(h)).toEqual(['R45']);
    expect(h[0]!.note).toContain('tidak pernah dibuat');
  });

  it('R45: tautan ke pesanan yang tidak ada atau belum diterima; satu pesanan ditautkan ke dua order', () => {
    const ghost = events((s) => link(s, 'x', 999, T));
    expect(webOrderHits([], ghost, T + 1000, 0)[0]).toMatchObject({ rule: 'R45', note: expect.stringContaining('tidak ada di outlet ini') });
    const notAcc = events((s) => link(s, 'x', 2, T));
    expect(webOrderHits([{ id: 2, status: 'REJECTED', estimatedTotal: 10_000, decidedAtMs: T }], notAcc, T + 1000, 0)[0]!.note).toContain('REJECTED');
    const dup = events((s) => { link(s, 'a', 1, T); link(s, 'b', 1, T + 60_000); pay(s, 'a', 50_000, T + 120_000); pay(s, 'b', 50_000, T + 130_000); });
    const h = webOrderHits([accepted(1)], dup, T + 3_600_000, 0);
    expect(h.filter((x) => x.rule === 'R45')).toHaveLength(1);
    expect(h[0]!.note).toContain('2 order kasir');
  });

  it('R45: duplikat tidak dihitung bila salah satu order di-void (tautan ulang sesudah salah buat)', () => {
    const ev = events((s) => { link(s, 'a', 1, T); s.pos({ type: 'void.approved', payload: { orderId: 'a', reasonCode: 'SALAH', approverIds: ['rina'], amount: 0 } } as never, T + 30_000, 'budi'); link(s, 'b', 1, T + 60_000); pay(s, 'b', 50_000, T + 120_000); });
    expect(webOrderHits([accepted(1)], ev, T + 3_600_000, 0).filter((x) => x.rule === 'R45')).toEqual([]);
  });

  it('R46: order kasir di-void; atau belum dibayar 3 jam setelah diterima', () => {
    const v = events((s) => { link(s, 'a', 1, T); s.pos({ type: 'void.approved', payload: { orderId: 'a', reasonCode: 'SALAH', approverIds: ['rina'], amount: 0 } } as never, T + 60_000, 'budi'); });
    expect(rules(webOrderHits([accepted(1)], v, T + 1_000_000, 0))).toEqual(['R46']);
    const u = events((s) => link(s, 'a', 1, T + 60_000));
    expect(webOrderHits([accepted(1)], u, T + UNPAID_AFTER_MS - 1, 0)).toEqual([]);
    expect(rules(webOrderHits([accepted(1)], u, T + UNPAID_AFTER_MS, 0))).toEqual(['R46']);
  });

  it('R47: dibayar jauh di bawah nilai pesanan (setelah dikurangi refund)', () => {
    const low = events((s) => { link(s, 'a', 1, T); pay(s, 'a', 20_000, T + 600_000); });
    expect(webOrderHits([accepted(1)], low, T + 3_600_000, 0)[0]).toMatchObject({ rule: 'R47', note: expect.stringContaining('Rp 20.000') });
    const refunded = events((s) => { link(s, 'a', 1, T); pay(s, 'a', 50_000, T + 600_000); s.pos({ type: 'refund.created', payload: { refundId: 'a-R1', originalOrderId: 'a', amount: 30_000, method: 'CASH', approverId: 'rina' } }, T + 700_000, 'budi'); });
    expect(rules(webOrderHits([accepted(1)], refunded, T + 3_600_000, 0))).toEqual(['R47']);
  });

  it('order digabung ke order lain atau dipecah bayar: bukan "belum dibayar" dan bukan "dibayar di bawah nilai"', () => {
    const moved = (s: Sim, kind: 'MERGE' | 'SPLIT', from: string, to: string, at: number) =>
      s.pos({ type: 'order.items_moved', payload: { fromOrderId: from, toOrderId: to, kind, items: [], sent: [] } } as never, at, 'budi');
    // digabung ke order lain: order asal tidak akan pernah dibayar, nilainya dibayar lewat order tujuan
    const merged = events((s) => { link(s, 'a', 1, T + 60_000); s.pos({ type: 'order.created', payload: { orderId: 'b', orderType: 'TAKE_AWAY' } }, T + 70_000, 'budi'); moved(s, 'MERGE', 'a', 'b', T + 120_000); pay(s, 'b', 50_000, T + 200_000); });
    expect(webOrderHits([accepted(1)], merged, T + 4 * 3_600_000, 0)).toEqual([]);
    // dipecah: separuh item dibayar di order pecahan, separuh di order asal (masing-masing 25.000 dari 50.000)
    const split = events((s) => {
      link(s, 'a', 1, T + 60_000);
      s.pos({ type: 'order.created', payload: { orderId: 'a-S1', orderType: 'TAKE_AWAY' } }, T + 70_000, 'budi');
      moved(s, 'SPLIT', 'a', 'a-S1', T + 120_000);
      s.pos({ type: 'payment.received', payload: { orderId: 'a', method: 'CASH', amount: 25_000 } }, T + 200_000, 'budi');
      s.pos({ type: 'payment.received', payload: { orderId: 'a-S1', method: 'CASH', amount: 25_000 } }, T + 210_000, 'budi');
    });
    expect(webOrderHits([accepted(1)], split, T + 4 * 3_600_000, 0)).toEqual([]);
    // tetapi bila yang dipecah tidak dibayar sama sekali, kekurangannya tetap ketahuan
    const unpaidSplit = events((s) => {
      link(s, 'a', 1, T + 60_000);
      s.pos({ type: 'order.created', payload: { orderId: 'a-S1', orderType: 'TAKE_AWAY' } }, T + 70_000, 'budi');
      moved(s, 'SPLIT', 'a', 'a-S1', T + 120_000);
      s.pos({ type: 'payment.received', payload: { orderId: 'a', method: 'CASH', amount: 10_000 } }, T + 200_000, 'budi');
    });
    expect(rules(webOrderHits([accepted(1)], unpaidSplit, T + 4 * 3_600_000, 0))).toEqual(['R47']);
  });

  it('temuan lama (sebelum jendela) tidak dikeluarkan', () => {
    expect(webOrderHits([accepted(1)], [], T + 5 * 3_600_000, T + 4 * 3_600_000)).toEqual([]);
  });
});
