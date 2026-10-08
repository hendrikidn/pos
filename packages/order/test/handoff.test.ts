import { describe, expect, it } from 'vitest';
import { EventChain, type EventBody, type LineItem, type PosEvent } from '@pos/events';
import { buildHandoffs, HANDOFF_MAX_AGE_MS, HANDOFF_RESULT_KEEP_MS } from '../src';

const T0 = Date.parse('2026-10-01T12:00:00+07:00');
const MIN = 60_000;

class Rec {
  readonly events: PosEvent[] = [];
  private readonly chains = new Map<string, EventChain>();
  at(min: number, body: EventBody, device: string): PosEvent {
    let c = this.chains.get(device);
    if (!c) this.chains.set(device, (c = new EventChain(device, 'o1')));
    const e = c.append({ ...body, deviceTime: T0 + min * MIN, actorId: null });
    this.events.push(e);
    return e;
  }
}
const items: LineItem[] = [{ itemId: 'kopi', name: 'Kopi', qty: 2, unitPrice: 20_000, sentQty: 1 }];
const handoff = (r: Rec, min: number, orderId: string, device = 'pos-2') =>
  r.at(min, { type: 'order.handed_off', payload: { orderId, orderType: 'DINE_IN', tableNo: '3', items } }, device);
const merge = (r: Rec, min: number, from: string, to: string, device: string) =>
  r.at(min, { type: 'order.items_moved', payload: { fromOrderId: from, toOrderId: to, kind: 'MERGE', items, sent: true } }, device);
const list = (r: Rec, min: number) => buildHandoffs({ events: r.events, now: T0 + min * MIN });

describe('daftar serah-terima order', () => {
  it('serah-terima baru menunggu; isi, meja, dan terminal asal terbawa', () => {
    const r = new Rec();
    const e = handoff(r, 0, 'pos-2-1');
    expect(list(r, 1)).toEqual([{ orderId: 'pos-2-1', fromDeviceId: 'pos-2', handoffSeq: e.seq, orderType: 'DINE_IN', tableNo: '3', items, at: T0, state: 'PENDING' }]);
  });

  it('diambil terminal lain = ACCEPTED dengan nama pengambil; MERGE oleh terminal asal sendiri tidak dihitung', () => {
    const r = new Rec();
    handoff(r, 0, 'a-1'); handoff(r, 1, 'a-2');
    merge(r, 2, 'a-1', 'pos-1-1', 'pos-1');
    merge(r, 2, 'a-2', 'pos-2-9', 'pos-2'); // order gabung biasa di terminal sendiri
    expect(list(r, 3).map((h) => [h.orderId, h.state, h.by])).toEqual([['a-1', 'ACCEPTED', 'pos-1'], ['a-2', 'PENDING', undefined]]);
  });

  it('ditarik kembali hanya sah dari terminal asal; setelah ditarik, serah-terima baru membuka entri baru', () => {
    const r = new Rec();
    handoff(r, 0, 'a-1');
    r.at(1, { type: 'order.handoff_reclaimed', payload: { orderId: 'a-1' } }, 'pos-1'); // terminal lain tidak berhak menarik
    expect(list(r, 2).map((h) => h.state)).toEqual(['PENDING']);
    r.at(3, { type: 'order.handoff_reclaimed', payload: { orderId: 'a-1' } }, 'pos-2');
    expect(list(r, 4).map((h) => h.state)).toEqual(['RECLAIMED']);
    handoff(r, 5, 'a-1');
    expect(list(r, 6).map((h) => h.state)).toEqual(['RECLAIMED', 'PENDING']);
    merge(r, 7, 'a-1', 'pos-1-3', 'pos-1');
    expect(list(r, 8).map((h) => h.state)).toEqual(['RECLAIMED', 'ACCEPTED']);
  });

  it('yang menunggu kedaluwarsa setelah 12 jam; hasil akhir dilaporkan sampai 48 jam', () => {
    const r = new Rec();
    handoff(r, 0, 'a-1'); handoff(r, 1, 'a-2');
    merge(r, 2, 'a-2', 'pos-1-1', 'pos-1');
    expect(list(r, HANDOFF_MAX_AGE_MS / MIN + 1).map((h) => h.orderId)).toEqual(['a-2']);
    expect(list(r, HANDOFF_RESULT_KEEP_MS / MIN + 2)).toEqual([]);
  });
});
