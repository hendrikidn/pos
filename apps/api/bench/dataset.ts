import type { Sim } from '@pos/sim';

const DAY = 86_400_000;

/** Menyusun `days` hari event untuk satu outlet sibuk: order tunai/QRIS tiga baris item, laci, sesekali void. Mengembalikan jumlah event. */
export function buildDataset(sims: Record<string, Sim>, terminals: string[], ordersPerDay: number, days: number): number {
  const staff = ['budi', 'sari', 'dewi'];
  let n = 0;
  for (let d = days - 1; d >= 0; d--) {
    const day0 = Date.parse('2026-10-09T08:00:00+07:00') - d * DAY;
    terminals.forEach((tid, ti) => {
      const sim = sims[tid]!;
      const actor = staff[ti]!;
      sim.pos({ type: 'shift.opened', payload: { shiftId: `S${d}-${tid}`, openingCash: 100_000 } } as never, day0, actor);
      for (let i = 0; i < ordersPerDay / terminals.length; i++) {
        const t = day0 + 60_000 + i * 55_000;
        const id = `${tid}-${d}-${i}`;
        const items = [{ itemId: 'kopi', name: 'Kopi', qty: 2, unitPrice: 22_000 }, { itemId: 'roti', name: 'Roti', qty: 1, unitPrice: 24_000 }, { itemId: 'teh', name: 'Teh', qty: 1, unitPrice: 18_000 }];
        const total = 86_000;
        sim.pos({ type: 'order.created', payload: { orderId: id, orderType: 'TAKE_AWAY' } }, t, actor);
        sim.pos({ type: 'order.sent_to_kitchen', payload: { orderId: id, items } }, t + 1000, actor);
        sim.pos({ type: 'bill.printed', payload: { orderId: id, total, items } }, t + 60_000, actor);
        const cash = i % 3 !== 0;
        if (cash) sim.pos({ type: 'drawer.opened', payload: { orderId: id } } as never, t + 61_000, actor);
        sim.pos({ type: 'payment.received', payload: cash ? { orderId: id, method: 'CASH', amount: total } : { orderId: id, method: 'QRIS', amount: total, tid: '12345678' } } as never, t + 62_000, actor);
        if (i % 97 === 0) sim.pos({ type: 'void.approved', payload: { orderId: id, reasonCode: 'SALAH', approverIds: ['sari'], amount: total } } as never, t + 90_000, actor);
        n += cash ? 6 : 5;
      }
      sim.pos({ type: 'shift.closed', payload: { shiftId: `S${d}-${tid}` } } as never, day0 + 12 * 3_600_000, actor);
    });
  }
  return n;
}
