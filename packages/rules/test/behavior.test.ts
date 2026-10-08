import { describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { evaluateBehaviorRules, type RuleHit } from '../src';

const DAY = 86_400_000;
const MIN = 60_000;
const H = 60 * MIN;

/** Dasar waktu: Selasa 06.00 WIB; hari ke-d dihitung dari sini. */
const base = (s: Sim) => s.t('06:00:00');
const run = (s: Sim, nowMs: number, over: Partial<Parameters<typeof evaluateBehaviorRules>[0]> = {}): RuleHit[] =>
  evaluateBehaviorRules({ events: s.events, now: nowMs, emitFrom: 0, ...over });
const rules = (h: RuleHit[]) => h.map((x) => x.rule).sort();

function order(s: Sim, id: string, at: number, actor: string, type: 'TAKE_AWAY' | 'EMPLOYEE' = 'TAKE_AWAY') {
  s.pos({ type: 'order.created', payload: { orderId: id, orderType: type } }, at, actor);
}
function voidIt(s: Sim, id: string, at: number, actor: string, approver: string) {
  s.pos({ type: 'void.approved', payload: { orderId: id, reasonCode: 'SALAH', approverIds: [approver], amount: 20_000 } }, at, actor);
}

describe('R11: pasangan kasir-penyetuju', () => {
  function voids(approvers: string[], withOtherOnDuty = true) {
    const s = new Sim();
    const T = base(s);
    approvers.forEach((a, i) => { order(s, `o${i}`, T + i * DAY + MIN, 'budi'); voidIt(s, `o${i}`, T + i * DAY + 5 * MIN, 'budi', a); });
    if (withOtherOnDuty) voidIt(s, 'x', T + 2 * MIN, 'sari', 'rina'); // rina bertugas di hari pertama, melayani kasir lain
    return { s, now: T + 10 * DAY };
  }
  it('6 void budi, 5 disetujui hendra (83%), rina juga bertugas: ditandai', () => {
    const { s, now } = voids(['hendra', 'hendra', 'hendra', 'hendra', 'hendra', 'rina']);
    const h = run(s, now).filter((x) => x.rule === 'R11');
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ actorIds: ['budi', 'hendra'] });
    expect(h[0]!.note).toContain('5 dari 6');
  });
  it('tidak ditandai: kurang dari 5 void, atau persentase di bawah 70%, atau penyetuju lain tidak pernah bertugas', () => {
    expect(rules(run(...Object.values(voids(['hendra', 'hendra', 'hendra', 'hendra'])) as [Sim, number]))).not.toContain('R11');
    expect(rules(run(...Object.values(voids(['hendra', 'hendra', 'hendra', 'hendra', 'rina', 'rina'])) as [Sim, number]))).not.toContain('R11'); // 67%
    expect(rules(run(...Object.values(voids(['hendra', 'hendra', 'hendra', 'hendra', 'hendra', 'hendra'], false)) as [Sim, number]))).not.toContain('R11'); // hendra satu-satunya penyetuju
  });
});

describe('R12: kasir menyimpang dari rekannya', () => {
  function shop(rates: Record<string, number>, orders = 40) {
    const s = new Sim();
    const T = base(s);
    let k = 0;
    for (const [actor, nVoid] of Object.entries(rates)) {
      for (let i = 0; i < orders; i++) {
        const id = `${actor}-${i}`;
        order(s, id, T + (k++) * MIN, actor);
        if (i < nVoid) voidIt(s, id, T + (k++) * MIN, actor, 'hendra');
      }
    }
    return { s, now: T + 5 * DAY };
  }
  it('void 20% sementara tiga rekan 2,5%: ditandai dengan rekan sebagai pembanding', () => {
    const { s, now } = shop({ budi: 8, sari: 1, dewi: 1, andi: 1 });
    const h = run(s, now).filter((x) => x.rule === 'R12');
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ actorIds: ['budi'] });
    expect(h[0]!.note).toContain('void 8 kali dari 40 order');
    expect(h[0]!.note).toContain('rekan rata-rata');
  });
  it('tidak ditandai: semua mirip, atau kejadian kurang dari 5, atau order kurang dari 30', () => {
    expect(rules(run(...Object.values(shop({ budi: 2, sari: 1, dewi: 2, andi: 1 })) as [Sim, number]))).not.toContain('R12');
    expect(rules(run(...Object.values(shop({ budi: 4, sari: 0, dewi: 0, andi: 0 })) as [Sim, number]))).not.toContain('R12');
    expect(rules(run(...Object.values(shop({ budi: 8, sari: 1, dewi: 1, andi: 1 }, 20)) as [Sim, number]))).not.toContain('R12');
  });
  it('lima kejadian atau lebih tetapi masih dalam sebaran rekan: tidak ditandai', () => {
    const { s, now } = shop({ budi: 6, sari: 5, dewi: 5, andi: 6 }); // 15% vs rekan 12,5%
    expect(rules(run(s, now))).not.toContain('R12');
  });
  it('rekan kurang dari dua: memakai ambang mutlak (void 12% dan minimal 5 kali)', () => {
    const { s, now } = shop({ budi: 6, sari: 1 }, 40); // 15% vs ambang 12%
    expect(run(s, now).some((x) => x.rule === 'R12' && x.actorIds[0] === 'budi' && x.note.includes('ambang 12%'))).toBe(true);
    const { s: s2, now: n2 } = shop({ budi: 4, sari: 1 }, 40);
    expect(rules(run(s2, n2))).not.toContain('R12');
  });
});

describe('R13: void dan ganti metode bayar saat kertas habis', () => {
  function scenario(inPaperOut: number, outside: number, paperHours: number) {
    const s = new Sim();
    const T = base(s);
    s.pos({ type: 'printer.status', payload: { state: 'paperOut', source: 'device' } }, T + 100 * H, 'budi');
    for (let i = 0; i < inPaperOut; i++) { order(s, `a${i}`, T + 100 * H + (i + 1) * MIN, 'budi'); voidIt(s, `a${i}`, T + 100 * H + (i + 1) * MIN + 20_000, 'budi', 'hendra'); }
    s.pos({ type: 'printer.status', payload: { state: 'ok', source: 'device' } }, T + 100 * H + paperHours * H, 'budi');
    for (let i = 0; i < outside; i++) { order(s, `b${i}`, T + 20 * H + i * H, 'budi'); voidIt(s, `b${i}`, T + 20 * H + i * H + 5 * MIN, 'budi', 'hendra'); }
    s.heartbeat('terminal', T + 200 * H);
    return { s, now: T + 201 * H };
  }
  it('6 dari 7 void saat kertas habis yang hanya ~2% waktu: ditandai', () => {
    const { s, now } = scenario(6, 1, 4);
    const h = run(s, now).filter((x) => x.rule === 'R13');
    expect(h).toHaveLength(1);
    expect(h[0]!.note).toContain('6 dari 7');
  });
  it('tidak ditandai: void tersebar, jumlah kurang, atau kertas habis memang lama', () => {
    expect(rules(run(...Object.values(scenario(2, 8, 4)) as [Sim, number]))).not.toContain('R13');
    expect(rules(run(...Object.values(scenario(4, 0, 4)) as [Sim, number]))).not.toContain('R13'); // < 5 kejadian
    expect(rules(run(...Object.values(scenario(6, 1, 90)) as [Sim, number]))).not.toContain('R13'); // kertas habis ~45% waktu
  });
});

describe('R17: laci kas terbuka tanpa pembayaran tunai', () => {
  const T = (s: Sim) => base(s) + 4 * H;
  it('dibuka bersama pembayaran tunai: aman; tanpa pembayaran: ditandai; pembayaran >30 detik: ditandai', () => {
    const s = new Sim();
    const t = T(s);
    s.pos({ type: 'payment.received', payload: { orderId: 'a', method: 'CASH', amount: 10_000 } }, t, 'budi');
    s.pos({ type: 'drawer.opened', payload: { orderId: 'a' } }, t + 2_000, 'budi');
    expect(rules(run(s, t + H))).toEqual([]);
    s.pos({ type: 'drawer.opened', payload: {} }, t + 10 * MIN, 'budi');
    s.pos({ type: 'payment.received', payload: { orderId: 'c', method: 'CASH', amount: 10_000 } }, t + 20 * MIN + 40_000, 'budi');
    s.pos({ type: 'drawer.opened', payload: { orderId: 'c' } }, t + 20 * MIN, 'budi'); // pembayaran 40 detik sesudahnya
    const h = run(s, t + H);
    expect(rules(h)).toEqual(['R17', 'R17']);
    expect(h.every((x) => x.weight === 30)).toBe(true);
  });
  it('dibayar non-tunai tidak membenarkan laci terbuka; dengan penyetuju dan alasan berbobot rendah', () => {
    const s = new Sim();
    const t = T(s);
    s.pos({ type: 'payment.received', payload: { orderId: 'q', method: 'QRIS', amount: 10_000, tid: '1' } }, t, 'budi');
    s.pos({ type: 'drawer.opened', payload: {} }, t + 1_000, 'budi');
    s.pos({ type: 'drawer.opened', payload: { reason: 'Tukar uang kecil', approverId: 'hendra' } }, t + 30 * MIN, 'budi');
    const h = run(s, t + H);
    expect(h.map((x) => x.weight).sort()).toEqual([10, 30]);
    expect(h.find((x) => x.weight === 10)!.note).toContain('Tukar uang kecil');
    expect(h.find((x) => x.weight === 10)!.actorIds).toEqual(['budi', 'hendra']);
  });
  it('refund tunai di sekitarnya juga membenarkan', () => {
    const s = new Sim();
    const t = T(s);
    s.pos({ type: 'refund.created', payload: { refundId: 'r1', originalOrderId: 'o', amount: 5_000, method: 'CASH', approverId: 'hendra' } }, t, 'budi');
    s.pos({ type: 'drawer.opened', payload: {} }, t + 5_000, 'budi');
    expect(rules(run(s, t + H))).toEqual([]);
  });
});

describe('R19: QR statis', () => {
  it('ditandai hanya bila EDC atau QR dinamis tersedia', () => {
    const s = new Sim();
    const t = base(s);
    s.pos({ type: 'payment.received', payload: { orderId: 'a', method: 'QR_STATIC', amount: 45_000 } }, t, 'budi');
    expect(rules(run(s, t + H, { dynamicQrAvailable: true }))).toEqual(['R19']);
    expect(rules(run(s, t + H, { dynamicQrAvailable: false }))).toEqual([]);
    expect(run(s, t + H, { dynamicQrAvailable: true })[0]).toMatchObject({ orderId: 'a', actorIds: ['budi'] });
  });
});

describe('R20: cetak ulang dan pindah meja menjelang tutup shift', () => {
  function shift(nLate: number, nEarly: number) {
    const s = new Sim();
    const T = base(s);
    s.pos({ type: 'shift.opened', payload: { shiftId: 's1', openingCash: 100_000 } }, T, 'budi');
    const bill = (id: string, at: number) => s.pos({ type: 'bill.printed', payload: { orderId: id, total: 20_000 } }, at, 'budi');
    for (let i = 0; i < nEarly; i++) { order(s, `e${i}`, T + (i + 1) * H, 'budi'); bill(`e${i}`, T + (i + 1) * H + MIN); bill(`e${i}`, T + (i + 1) * H + 2 * MIN); }
    for (let i = 0; i < nLate; i++) { order(s, `l${i}`, T + 8 * H + i * MIN, 'budi'); bill(`l${i}`, T + 8 * H + i * MIN + 10_000); bill(`l${i}`, T + 8 * H + i * MIN + 20_000); }
    s.pos({ type: 'shift.closed', payload: { shiftId: 's1' } }, T + 8 * H + 30 * MIN, 'budi');
    return { s, now: T + 9 * H };
  }
  it('4 dari 5 cetak ulang di jam terakhir: ditandai', () => {
    const { s, now } = shift(4, 1);
    const h = run(s, now).filter((x) => x.rule === 'R20');
    expect(h).toHaveLength(1);
    expect(h[0]!.note).toContain('4 cetak ulang');
  });
  it('tidak ditandai bila yang menumpuk di jam terakhir kurang dari separuh shift (3 dari 8)', () => {
    expect(rules(run(...Object.values(shift(3, 5)) as [Sim, number]))).not.toContain('R20');
  });
  it('tidak ditandai: tersebar sepanjang shift, atau kurang dari 3 di akhir', () => {
    expect(rules(run(...Object.values(shift(2, 6)) as [Sim, number]))).not.toContain('R20');
    expect(rules(run(...Object.values(shift(2, 0)) as [Sim, number]))).not.toContain('R20');
  });
  it('pindah meja menjelang tutup ikut dihitung', () => {
    const s = new Sim();
    const T = base(s);
    s.pos({ type: 'shift.opened', payload: { shiftId: 's1', openingCash: 0 } }, T, 'budi');
    for (let i = 0; i < 3; i++) { order(s, `m${i}`, T + 8 * H + i * MIN, 'budi'); s.pos({ type: 'order.table_changed', payload: { orderId: `m${i}`, from: '1', to: '2' } }, T + 8 * H + i * MIN + 5_000, 'budi'); }
    s.pos({ type: 'shift.closed', payload: { shiftId: 's1' } }, T + 8 * H + 20 * MIN, 'budi');
    expect(rules(run(s, T + 9 * H))).toContain('R20');
  });
});

describe('batas jendela dan stabilitas', () => {
  it('temuan sebelum emitFrom tidak dikeluarkan; kunci stabil antar evaluasi', () => {
    const s = new Sim();
    const t = base(s);
    s.pos({ type: 'payment.received', payload: { orderId: 'a', method: 'QR_STATIC', amount: 45_000 } }, t, 'budi');
    expect(rules(run(s, t + H, { dynamicQrAvailable: true, emitFrom: t + 1 }))).toEqual([]);
    const a = run(s, t + H, { dynamicQrAvailable: true }).map((x) => x.key);
    const b = run(s, t + 2 * H, { dynamicQrAvailable: true }).map((x) => x.key);
    expect(a).toEqual(b);
  });
});
