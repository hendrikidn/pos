import { describe, expect, it } from 'vitest';
import type { EventBody } from '@pos/events';
import { Sim } from '@pos/sim';
import {
  buildIncidents, evaluateRules, levelOf, multiplier,
  type Capabilities, type RuleHit,
} from '../src';

const FULL: Capabilities = { sensor: true, kds: true, printerReportsStatus: true };
const NO_SENSOR: Capabilities = { sensor: false, kds: false, printerReportsStatus: false };

function run(sim: Sim, nowHms: string, caps: Capabilities = FULL): RuleHit[] {
  return evaluateRules({ events: sim.events, now: sim.t(nowHms), terminals: [sim.terminalId], capabilities: caps });
}
const rules = (hits: RuleHit[]) => hits.map((h) => h.rule).sort();

const voidBody = (orderId: string): EventBody => ({
  type: 'void.approved',
  payload: { orderId, reasonCode: 'CUSTOMER_CANCEL', approverIds: ['hendra'], amount: 50_000 },
});

describe('hari normal', () => {
  it('order tunai dengan customer di depan kasir tidak memicu apa pun', () => {
    const s = new Sim();
    s.presence('10:00:00', '10:01:00');
    s.cashOrder('o1', '10:00:10', '10:00:50');
    s.heartbeat('terminal', '10:30:00');
    expect(run(s, '11:00:00')).toEqual([]);
  });
});

describe('kasus phantom void (contoh dokumen draft)', () => {
  function phantom(): Sim {
    const s = new Sim();
    s.heartbeats('sensor', '12:50:00', '13:30:00', 60_000);
    s.pos({ type: 'printer.status', payload: { state: 'paperOut', source: 'device' } }, '12:55:00');
    s.presence('13:14:02', '13:15:00');
    s.pos({ type: 'order.created', payload: { orderId: 'o42', orderType: 'TAKE_AWAY' } }, '13:14:30', 'budi');
    s.pos({ type: 'order.sent_to_kitchen', payload: { orderId: 'o42' } }, '13:14:35', 'budi');
    s.pos({ type: 'bill.printed', payload: { orderId: 'o42', total: 185_000 } }, '13:14:40', 'budi');
    s.pos({ type: 'payment.received', payload: { orderId: 'o42', method: 'CASH', amount: 185_000 } }, '13:14:50', 'budi');
    s.pos({ type: 'kitchen.status_changed', payload: { orderId: 'o42', status: 'COOKING' } }, '13:16:00', 'dapur');
    s.pos({ type: 'kitchen.status_changed', payload: { orderId: 'o42', status: 'READY' } }, '13:17:40', 'dapur');
    s.pos(voidBody('o42'), '13:18:45', 'budi');
    return s;
  }

  it('memicu R2, R3, dan R5', () => {
    expect(rules(run(phantom(), '13:30:00'))).toEqual(['R2', 'R3', 'R5']);
  });

  it('menjadi satu insiden kritis: (30 + 35 + 20) × 2,0 = 170', () => {
    const incidents = buildIncidents(run(phantom(), '13:30:00'));
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ score: 170, multiplier: 2, level: 'CRITICAL', orderIds: ['o42'] });
    expect(incidents[0]!.actorIds).toEqual(expect.arrayContaining(['budi', 'hendra']));
  });
});

describe('R1: presence lama tanpa order', () => {
  it('memicu bila tidak ada order dalam 3 menit', () => {
    const s = new Sim();
    s.presence('10:00:00', '10:01:00');
    s.heartbeat('terminal', '10:10:00');
    const hits = run(s, '10:30:00');
    expect(rules(hits)).toEqual(['R1']);
    expect(hits[0]!.weight).toBe(15);
  });

  it('presence singkat (< 45 dtk) diabaikan', () => {
    const s = new Sim();
    s.presence('10:00:00', '10:00:30');
    s.heartbeat('terminal', '10:10:00');
    expect(run(s, '10:30:00')).toEqual([]);
  });

  it('laci terbuka saat presence menaikkan bobot', () => {
    const s = new Sim();
    s.presence('10:00:00', '10:01:00');
    s.pos({ type: 'drawer.opened', payload: {} }, '10:00:30');
    s.heartbeat('terminal', '10:10:00');
    expect(run(s, '10:30:00')[0]!.weight).toBe(30);
  });

  it('ditunda sampai data terminal lengkap, bukan alarm palsu saat POS offline', () => {
    const s = new Sim();
    s.presence('10:00:00', '10:01:00');
    s.heartbeat('terminal', '10:01:00'); // terminal berhenti mengirim sebelum jendela 3 menit habis
    expect(run(s, '10:05:00')).toEqual([]); // belum lewat masa tunggu
    expect(rules(run(s, '10:40:00'))).toEqual(['R1']); // lewat masa tunggu 30 menit
  });

  it('order yang tiba dalam jendela membatalkan hit', () => {
    const s = new Sim();
    s.presence('10:00:00', '10:01:00');
    s.cashOrder('o1', '10:02:00', '10:02:30');
    s.heartbeat('terminal', '10:10:00');
    expect(run(s, '10:30:00')).toEqual([]);
  });
});

describe('R2: void setelah produksi', () => {
  it('tanpa KDS: void > 5 menit setelah dikirim ke dapur → bobot 20', () => {
    const s = new Sim();
    s.cashOrder('o1', '10:00:00', '10:00:30');
    s.pos(voidBody('o1'), '10:07:00');
    const hits = run(s, '10:30:00', NO_SENSOR);
    expect(hits.map((h) => [h.rule, h.weight])).toEqual([['R2', 20]]);
  });

  it('tanpa KDS: void cepat tidak memicu', () => {
    const s = new Sim();
    s.cashOrder('o1', '10:00:00', '10:00:30');
    s.pos(voidBody('o1'), '10:02:00');
    expect(run(s, '10:30:00', NO_SENSOR)).toEqual([]);
  });
});

describe('R3: void setelah customer pergi', () => {
  it('void saat customer masih di kasir tidak memicu', () => {
    const s = new Sim();
    s.presence('10:00:00', '10:05:00');
    s.cashOrder('o1', '10:00:10', '10:00:40');
    s.pos(voidBody('o1'), '10:04:00');
    s.heartbeat('terminal', '10:30:00');
    expect(rules(run(s, '11:00:00', { ...FULL, kds: false }))).not.toContain('R3');
  });

  it('dua sesi presence yang sama kuat → keyakinan rendah, bobot dibelah', () => {
    const s = new Sim();
    s.presence('10:00:00', '10:01:00');
    s.presence('10:00:05', '10:01:05');
    s.cashOrder('o1', '10:00:10', '10:00:50');
    s.pos(voidBody('o1'), '10:05:00');
    const r3 = run(s, '11:00:00', { ...FULL, kds: false }).find((h) => h.rule === 'R3')!;
    expect(r3.confidence).toBe('LOW');
    expect(r3.weight).toBe(18);
  });
});

describe('diskon dan metode bayar', () => {
  it('R18: diskon setelah bill dicetak tanpa persetujuan = 30, dengan persetujuan = 10', () => {
    const s = new Sim();
    s.pos({ type: 'order.created', payload: { orderId: 'o1', orderType: 'DINE_IN' } }, '10:00:00');
    s.pos({ type: 'bill.printed', payload: { orderId: 'o1', total: 100_000 } }, '10:10:00');
    s.pos({ type: 'discount.applied', payload: { orderId: 'o1', kind: 'MEMBER', amount: 20_000, percent: 20, verified: true } }, '10:11:00');
    s.pos({ type: 'discount.applied', payload: { orderId: 'o1', kind: 'MEMBER', amount: 5_000, percent: 5, verified: true, approverId: 'hendra' } }, '10:12:00');
    const hits = run(s, '10:40:00', NO_SENSOR).filter((h) => h.rule === 'R18');
    expect(hits.map((h) => h.weight)).toEqual([30, 10]);
  });

  it('R23: diskon manual besar tanpa verifikasi atau persetujuan', () => {
    const s = new Sim();
    s.pos({ type: 'order.created', payload: { orderId: 'o1', orderType: 'DINE_IN' } }, '10:00:00');
    s.pos({ type: 'discount.applied', payload: { orderId: 'o1', kind: 'MANUAL', amount: 40_000, percent: 40, verified: false } }, '10:01:00');
    expect(rules(run(s, '10:40:00', NO_SENSOR))).toEqual(['R23']);
  });

  it('R22: metode bayar diubah setelah lunas', () => {
    const s = new Sim();
    s.cashOrder('o1', '10:00:00', '10:00:30');
    s.pos({ type: 'payment.method_changed', payload: { orderId: 'o1', from: 'QRIS', to: 'CASH' } }, '10:05:00');
    expect(rules(run(s, '10:40:00', NO_SENSOR))).toEqual(['R22']);
  });
});

describe('R21: refund tanpa customer', () => {
  const refund = {
    type: 'refund.created',
    payload: { refundId: 'r1', originalOrderId: 'o1', amount: 30_000, method: 'CASH', approverId: 'hendra' },
  } as const;

  it('memicu bila tidak ada presence di sekitar refund', () => {
    const s = new Sim();
    s.cashOrder('o1', '09:00:00', '09:00:30');
    s.pos(refund, '10:00:00');
    s.heartbeat('terminal', '10:10:00');
    expect(rules(run(s, '10:30:00'))).toContain('R21');
  });

  it('tidak memicu bila customer ada di depan kasir', () => {
    const s = new Sim();
    s.cashOrder('o1', '09:00:00', '09:00:30');
    s.presence('09:59:00', '10:01:00');
    s.pos(refund, '10:00:00');
    s.heartbeat('terminal', '10:10:00');
    expect(rules(run(s, '10:30:00'))).not.toContain('R21');
  });
});

describe('R25: order tanpa presence berulang', () => {
  it('5 order berturut-turut tanpa presence memicu sekali', () => {
    const s = new Sim();
    for (let i = 0; i < 6; i++) {
      const m = String(i * 5).padStart(2, '0');
      s.cashOrder(`o${i}`, `10:${m}:00`, `10:${m}:30`);
    }
    s.heartbeat('terminal', '11:00:00');
    const r25 = run(s, '11:30:00').filter((h) => h.rule === 'R25');
    expect(r25).toHaveLength(1);
    expect(r25[0]!.weight).toBe(25);
  });

  it('presence di sela-sela memutus rangkaian', () => {
    const s = new Sim();
    for (let i = 0; i < 6; i++) {
      const m = String(i * 5).padStart(2, '0');
      if (i === 2) s.presence(`10:${m}:00`, `10:${m}:40`);
      s.cashOrder(`o${i}`, `10:${m}:00`, `10:${m}:30`);
    }
    s.heartbeat('terminal', '11:00:00');
    expect(run(s, '11:30:00').filter((h) => h.rule === 'R25')).toEqual([]);
  });
});

describe('printer: R5 dan R5b', () => {
  it('R5b: klaim kertas habis padahal printer melaporkan normal', () => {
    const s = new Sim();
    s.pos({ type: 'printer.status', payload: { state: 'ok', source: 'device' } }, '10:00:00');
    s.pos({ type: 'printer.paper_claim', payload: { active: true } }, '10:05:00');
    const hits = run(s, '10:10:00');
    expect(rules(hits)).toEqual(['R5B']);
    expect(hits[0]!.weight).toBe(25);
  });

  it('klaim kertas habis saat printer memang melaporkan habis tidak memicu R5b', () => {
    const s = new Sim();
    s.pos({ type: 'printer.status', payload: { state: 'paperOut', source: 'device' } }, '10:04:00');
    s.pos({ type: 'printer.paper_claim', payload: { active: true } }, '10:05:00');
    expect(rules(run(s, '10:10:00'))).not.toContain('R5B');
  });

  it('R5: klaim kasir berkepanjangan sementara transaksi berjalan (printer tanpa status)', () => {
    const s = new Sim();
    s.pos({ type: 'printer.paper_claim', payload: { active: true } }, '10:00:00');
    s.cashOrder('o1', '10:20:00', '10:20:30');
    const hits = run(s, '10:40:00', { sensor: false, kds: false, printerReportsStatus: false });
    expect(rules(hits)).toEqual(['R5']);
  });

  it('kertas habis sebentar lalu diganti tidak memicu', () => {
    const s = new Sim();
    s.pos({ type: 'printer.status', payload: { state: 'paperOut', source: 'device' } }, '10:00:00');
    s.pos({ type: 'printer.status', payload: { state: 'ok', source: 'device' } }, '10:05:00');
    s.cashOrder('o1', '10:20:00', '10:20:30');
    expect(rules(run(s, '10:40:00'))).toEqual([]);
  });
});

describe('R4: sensor berhenti mengirim detak', () => {
  it('memicu bila POS tetap bertransaksi tanpa detak sensor', () => {
    const s = new Sim();
    s.heartbeats('sensor', '10:00:00', '10:10:00');
    s.cashOrder('o1', '10:20:00', '10:20:30');
    const r4 = run(s, '10:30:00').filter((h) => h.rule === 'R4');
    expect(r4).toHaveLength(1);
    expect(r4[0]!.weight).toBe(40);
  });

  it('toko tutup (POS juga diam) tidak memicu', () => {
    const s = new Sim();
    s.heartbeats('sensor', '10:00:00', '10:10:00');
    expect(run(s, '12:00:00').filter((h) => h.rule === 'R4')).toEqual([]);
  });
});

describe('R24: integritas', () => {
  it('event yang dihapus dari rantai terminal terdeteksi', () => {
    const s = new Sim();
    s.cashOrder('o1', '10:00:00', '10:00:30');
    const tampered = s.events.filter((e) => !(e.deviceId === s.terminalId && e.seq === 3));
    const hits = evaluateRules({
      events: tampered, now: s.t('10:30:00'), terminals: [s.terminalId], capabilities: NO_SENSOR,
    });
    expect(hits.some((h) => h.rule === 'R24' && h.note.startsWith('SEQ_GAP'))).toBe(true);
  });
});

describe('skoring dan insiden', () => {
  it('pengali sesuai SPEC', () => {
    expect(multiplier(1, 1)).toBe(1);
    expect(multiplier(2, 1)).toBeCloseTo(1.3);
    expect(multiplier(3, 1)).toBeCloseTo(1.6);
    expect(multiplier(3, 2)).toBeCloseTo(2.0);
    expect(multiplier(6, 2)).toBe(2);
  });

  it('batas level', () => {
    expect(levelOf(39)).toBe('LOW');
    expect(levelOf(40)).toBe('MEDIUM');
    expect(levelOf(69)).toBe('MEDIUM');
    expect(levelOf(70)).toBe('CRITICAL');
  });

  it('satu kertas habis tidak menggabungkan order yang tidak berkaitan', () => {
    const s = new Sim();
    s.pos({ type: 'printer.status', payload: { state: 'paperOut', source: 'device' } }, '09:30:00');
    for (const [id, c, p, v] of [['a', '10:00:00', '10:00:30', '10:03:00'], ['b', '10:30:00', '10:30:30', '10:33:00']] as const) {
      s.cashOrder(id, c, p);
      s.pos({ type: 'kitchen.status_changed', payload: { orderId: id, status: 'COOKING' } }, c.replace(':00:', ':01:'));
      s.pos(voidBody(id), v);
    }
    const incidents = buildIncidents(run(s, '11:00:00', { sensor: false, kds: true, printerReportsStatus: true }));
    expect(incidents).toHaveLength(2);
    for (const inc of incidents) {
      expect(inc.hits.map((h) => h.rule).sort()).toEqual(['R2', 'R5']);
      expect(inc.score).toBe(85);
      expect(inc.level).toBe('CRITICAL');
    }
  });

  it('jendela insiden tidak melebar karena hit kondisi berjam-jam (dipakai untuk mencari rekaman CCTV)', () => {
    const s = new Sim();
    s.heartbeats('sensor', '09:00:00', '11:00:00', 60_000);
    s.pos({ type: 'printer.status', payload: { state: 'paperOut', source: 'device' } }, '09:30:00');
    s.presence('10:00:00', '10:01:00');
    s.cashOrder('o1', '10:00:10', '10:00:50');
    s.pos({ type: 'kitchen.status_changed', payload: { orderId: 'o1', status: 'COOKING' } }, '10:02:00');
    s.pos(voidBody('o1'), '10:05:00');
    const [inc] = buildIncidents(run(s, '11:00:00'));
    expect(inc!.hits.some((h) => h.rule === 'R5')).toBe(true);
    expect(inc!.startAt).toBeGreaterThanOrEqual(s.t('10:00:00'));
    expect(inc!.endAt).toBeLessThanOrEqual(s.t('10:05:00'));
  });

  it('hit tunggal berbobot rendah tidak menjadi alert', () => {
    const s = new Sim();
    s.presence('10:00:00', '10:01:00');
    s.heartbeat('terminal', '10:10:00');
    const [inc] = buildIncidents(run(s, '10:30:00'));
    // R1 sendiri mengaitkan sensor dan POS (dua modalitas), jadi pengalinya 1,4: 15 × 1,4 = 21
    expect(inc).toMatchObject({ score: 21, level: 'LOW' });
  });
});
