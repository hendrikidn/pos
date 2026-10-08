import { describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { buildIntervals, computePay, netPay, splitByDay, MAX_OPEN_MS } from '../src/payroll';

const at = (iso: string) => Date.parse(`${iso}+07:00`);
const D = '2026-10-02';

describe('buildIntervals', () => {
  const clock = (s: Sim, hms: string, kind: 'IN' | 'OUT', actor: string, day = D) => s.pos({ type: 'attendance.clocked', payload: { kind } }, at(`${day}T${hms}`), actor);

  it('masuk-pulang menjadi rentang per staf; masuk ganda dan pulang tanpa masuk diabaikan', () => {
    const s = new Sim('o1', D, 'term-1', 'sensor-1');
    clock(s, '09:00:00', 'IN', 'budi'); clock(s, '09:05:00', 'IN', 'budi'); clock(s, '17:00:00', 'OUT', 'budi');
    clock(s, '08:00:00', 'OUT', 'sari'); clock(s, '10:00:00', 'IN', 'sari'); clock(s, '18:30:00', 'OUT', 'sari');
    const { done, open } = buildIntervals(s.events, at(`${D}T20:00:00`));
    expect(open).toEqual([]);
    expect(done.map((i) => [i.staffId, (i.end - i.start) / 60_000]).sort()).toEqual([['budi', 480], ['sari', 510]]);
    expect(done.find((i) => i.staffId === 'budi')).toMatchObject({ start: at(`${D}T09:00:00`), end: at(`${D}T17:00:00`), manual: false, terminalId: 'term-1' });
    expect(done.find((i) => i.staffId === 'sari')).toMatchObject({ start: at(`${D}T10:00:00`) });
  });

  it('absen masuk yang belum ditutup dilaporkan terbuka, dan usang setelah 16 jam', () => {
    const s = new Sim('o1', D, 'term-1', 'sensor-1');
    clock(s, '09:00:00', 'IN', 'budi');
    expect(buildIntervals(s.events, at(`${D}T20:00:00`)).open).toEqual([expect.objectContaining({ staffId: 'budi', stale: false })]);
    expect(buildIntervals(s.events, at(`${D}T09:00:00`) + MAX_OPEN_MS + 1).open[0]!.stale).toBe(true);
    expect(buildIntervals(s.events, at(`${D}T20:00:00`)).done).toEqual([]);
  });

  it('pulang di waktu yang sama atau lebih awal dari masuk tidak membuat rentang', () => {
    const s = new Sim('o1', D, 'term-1', 'sensor-1');
    clock(s, '09:00:00', 'IN', 'budi'); clock(s, '09:00:00', 'OUT', 'budi');
    expect(buildIntervals(s.events, at(`${D}T20:00:00`)).done).toEqual([]);
  });
});

describe('splitByDay', () => {
  it('rentang melewati tengah malam dipecah menurut hari lokal outlet', () => {
    expect(splitByDay(at('2026-10-02T22:00:00'), at('2026-10-03T02:30:00'), 420)).toEqual([{ date: '2026-10-02', minutes: 120 }, { date: '2026-10-03', minutes: 150 }]);
    expect(splitByDay(at('2026-10-02T09:00:00'), at('2026-10-02T17:00:00'), 420)).toEqual([{ date: '2026-10-02', minutes: 480 }]);
  });
  it('tengah malam UTC bukan tengah malam WIB', () => {
    expect(splitByDay(at('2026-10-02T06:00:00'), at('2026-10-02T08:00:00'), 420)).toEqual([{ date: '2026-10-02', minutes: 120 }]); // 23.00–01.00 UTC melintasi UTC, tidak WIB
  });
});

describe('computePay', () => {
  const day = (d: string, from: string, to: string) => ({ start: at(`${d}T${from}`), end: at(`${d}T${to}`) });

  it('per jam: jam reguler sampai 8 jam per hari, selebihnya lembur dengan pengali', () => {
    const r = computePay([day('2026-10-02', '09:00:00', '19:30:00'), day('2026-10-03', '10:00:00', '16:00:00')], { payType: 'HOURLY', rate: 20_000, overtimeMultiplier: 1.5 }, 420);
    expect(r).toMatchObject({ regularMinutes: 480 + 360, overtimeMinutes: 150, base: 280_000, overtimePay: 75_000 }); // 14 jam × 20.000; 2,5 jam × 20.000 × 1,5
    expect(r.days).toEqual([{ date: '2026-10-02', minutes: 630 }, { date: '2026-10-03', minutes: 360 }]);
  });

  it('beberapa rentang di hari yang sama dijumlah sebelum dibagi reguler dan lembur', () => {
    const r = computePay([day('2026-10-02', '08:00:00', '12:00:00'), day('2026-10-02', '13:00:00', '19:00:00')], { payType: 'HOURLY', rate: 10_000, overtimeMultiplier: 2 }, 420);
    expect(r).toMatchObject({ regularMinutes: 480, overtimeMinutes: 120, base: 80_000, overtimePay: 40_000 });
  });

  it('bulanan: gaji tetap; lembur memakai tarif gaji ÷ 173 jam', () => {
    const r = computePay([day('2026-10-02', '09:00:00', '19:00:00')], { payType: 'MONTHLY', rate: 3_460_000, overtimeMultiplier: 1.5 }, 420);
    expect(r).toMatchObject({ base: 3_460_000, overtimeMinutes: 120, overtimePay: Math.round(2 * (3_460_000 / 173) * 1.5) }); // 2 jam × 20.000 × 1,5 = 60.000
    expect(r.overtimePay).toBe(60_000);
  });

  it('tanpa rentang kerja: per jam nol; bulanan tetap gaji pokok; batas harian bisa diubah', () => {
    expect(computePay([], { payType: 'HOURLY', rate: 20_000, overtimeMultiplier: 1.5 }, 420)).toMatchObject({ base: 0, overtimePay: 0, days: [] });
    expect(computePay([], { payType: 'MONTHLY', rate: 3_000_000, overtimeMultiplier: 1.5 }, 420)).toMatchObject({ base: 3_000_000, overtimePay: 0 });
    const r = computePay([day('2026-10-02', '09:00:00', '16:00:00')], { payType: 'HOURLY', rate: 10_000, overtimeMultiplier: 2 }, 420, 360);
    expect(r).toMatchObject({ regularMinutes: 360, overtimeMinutes: 60, base: 60_000, overtimePay: 20_000 });
  });
});

describe('netPay', () => {
  it('pokok + lembur + tunjangan − potongan, tidak negatif', () => {
    expect(netPay(1_000_000, 100_000, 50_000, 30_000)).toBe(1_120_000);
    expect(netPay(100_000, 0, 0, 500_000)).toBe(0);
  });
});
