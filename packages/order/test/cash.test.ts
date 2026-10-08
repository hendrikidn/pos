import { describe, expect, it } from 'vitest';
import { EventChain, type EventBody, type EventOf, type PosEvent } from '@pos/events';
import { verifyCashCount } from '../src';

const T0 = Date.parse('2026-10-01T08:00:00+07:00');

function chain(device = 'term-1') {
  const c = new EventChain(device, 'o1');
  const events: PosEvent[] = [];
  return {
    events,
    add: (body: EventBody, min = 0) => { const e = c.append({ ...body, deviceTime: T0 + min * 60_000, actorId: 'budi' }); events.push(e); return e; },
  };
}
const opened = (id: string, cash: number): EventBody => ({ type: 'shift.opened', payload: { shiftId: id, openingCash: cash } });
const pay = (amount: number, method: 'CASH' | 'QRIS' = 'CASH'): EventBody => ({ type: 'payment.received', payload: { orderId: 'o', method, amount } });
const refund = (amount: number, method: 'CASH' | 'QRIS' = 'CASH'): EventBody => ({ type: 'refund.created', payload: { refundId: 'r', originalOrderId: 'o', amount, method, approverId: 'h' } });
const counted = (id: string, counted: number, expected: number): EventBody => ({ type: 'cash.counted', payload: { shiftId: id, counted, expected } });
const verify = (c: ReturnType<typeof chain>, e: PosEvent) => verifyCashCount(e as EventOf<'cash.counted'>, c.events);

describe('hitung ulang kas yang seharusnya (server)', () => {
  it('modal + tunai − refund tunai; QRIS dan kartu tidak masuk laci; sama dengan klaim terminal → OK', () => {
    const c = chain();
    c.add(opened('S1', 100_000));
    c.add(pay(50_000)); c.add(pay(30_000, 'QRIS')); c.add(pay(20_000)); c.add(refund(10_000)); c.add(refund(99_999, 'QRIS'));
    const e = c.add(counted('S1', 160_000, 160_000));
    expect(verify(c, e)).toMatchObject({ status: 'OK', serverExpected: 160_000, openingCash: 100_000, cashIn: 70_000, cashOut: 10_000 });
  });

  it('klaim terminal dipalsukan agar selisih nol (expected = counted): MISMATCH dengan angka server yang benar', () => {
    const c = chain();
    c.add(opened('S1', 100_000));
    c.add(pay(200_000));
    // laci seharusnya 300.000, kasir mengambil 80.000 dan memalsukan expected supaya cocok dengan yang dihitung
    const e = c.add(counted('S1', 220_000, 220_000));
    expect(verify(c, e)).toMatchObject({ status: 'MISMATCH', claimed: 220_000, serverExpected: 300_000 });
  });

  it('hanya shift yang bersangkutan: pembayaran sebelum pembukaan dan sesudah penutupan, serta shift lain, tidak ikut', () => {
    const c = chain();
    c.add(opened('S1', 50_000)); c.add(pay(10_000)); const e1 = c.add(counted('S1', 60_000, 60_000));
    c.add(pay(7_000)); // di antara shift: tidak ada shift terbuka, tidak dihitung ke S2
    c.add(opened('S2', 20_000)); c.add(pay(5_000)); const e2 = c.add(counted('S2', 25_000, 25_000));
    expect(verify(c, e1)).toMatchObject({ status: 'OK', serverExpected: 60_000 });
    expect(verify(c, e2)).toMatchObject({ status: 'OK', serverExpected: 25_000 });
  });

  it('perangkat lain tidak ikut dihitung', () => {
    const a = chain('term-1');
    const b = chain('term-2');
    a.add(opened('S1', 10_000)); b.add(pay(999_000));
    const e = a.add(counted('S1', 10_000, 10_000));
    expect(verifyCashCount(e as EventOf<'cash.counted'>, [...a.events, ...b.events])).toMatchObject({ status: 'OK', serverExpected: 10_000 });
  });

  it('rantai tidak utuh (event hilang di antara pembukaan dan penutupan): tidak dapat diverifikasi, bukan dianggap cocok atau salah', () => {
    const c = chain();
    c.add(opened('S1', 100_000)); c.add(pay(50_000)); c.add(pay(20_000));
    const e = c.add(counted('S1', 170_000, 170_000));
    const lost = c.events.filter((x) => x.seq !== 2); // pembayaran 50.000 tidak sampai
    expect(verifyCashCount(e as EventOf<'cash.counted'>, lost)).toMatchObject({ status: 'UNVERIFIABLE', reason: 'CHAIN_GAP', serverExpected: null });
  });

  it('tanpa shift.opened yang cocok: tidak dapat diverifikasi', () => {
    const c = chain();
    c.add(pay(50_000));
    const e = c.add(counted('S9', 50_000, 50_000));
    expect(verify(c, e)).toMatchObject({ status: 'UNVERIFIABLE', reason: 'NO_SHIFT_OPEN' });
  });
});
