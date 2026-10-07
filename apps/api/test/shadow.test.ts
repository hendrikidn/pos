import { describe, expect, it } from 'vitest';
import { buildShadowSummary, clampShadowStart, shadowState, MAX_BACKDATE_MS, type ShadowIncident } from '../src/shadow';
import { DAY_MS } from '../src/sales-report';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const START = WIB('2026-10-01T09:00:00');

describe('shadowState', () => {
  it('days = 0: nonaktif', () => {
    expect(shadowState(0, null, START)).toMatchObject({ enabled: false, active: false, pending: false, day: 0 });
    expect(shadowState(0, START, START + 99 * DAY_MS)).toMatchObject({ enabled: false, active: false });
  });

  it('aktif tetapi menunggu aktivitas pertama: hari belum berhitung', () => {
    expect(shadowState(14, null, START)).toEqual({ days: 14, enabled: true, active: true, pending: true, startedMs: null, untilMs: null, day: 0 });
  });

  it('hari ke-N: hari 1 pada 24 jam pertama, hari 14 pada 24 jam terakhir, dan berakhir tepat pada batasnya', () => {
    const at = (ms: number) => shadowState(14, START, START + ms);
    expect(at(0)).toMatchObject({ active: true, day: 1, untilMs: START + 14 * DAY_MS });
    expect(at(DAY_MS - 1)).toMatchObject({ day: 1 });
    expect(at(DAY_MS)).toMatchObject({ day: 2 });
    expect(at(14 * DAY_MS - 1)).toMatchObject({ active: true, day: 14 });
    expect(at(14 * DAY_MS)).toMatchObject({ active: false, day: 14, enabled: true });
    expect(at(30 * DAY_MS)).toMatchObject({ active: false });
  });

  it('jam awal di masa depan (jam perangkat salah) tidak menghasilkan hari negatif', () => {
    expect(shadowState(14, START + 3_600_000, START).day).toBe(1);
  });

  it('lama diubah: batas ikut bergeser dari awal yang sama', () => {
    expect(shadowState(30, START, START + 20 * DAY_MS)).toMatchObject({ active: true, day: 21 });
    expect(shadowState(7, START, START + 20 * DAY_MS)).toMatchObject({ active: false });
  });
});

describe('clampShadowStart', () => {
  const now = START + 5 * DAY_MS;
  it('event wajar dipakai apa adanya', () => expect(clampShadowStart(now - 3_600_000, now)).toBe(now - 3_600_000));
  it('di masa depan dibatasi ke sekarang (tidak bisa memperpanjang shadow dan membungkam notifikasi)', () => {
    expect(clampShadowStart(now + 10 * DAY_MS, now)).toBe(now);
  });
  it('terlalu lama ke belakang dibatasi 2 hari (tidak bisa mengakhiri shadow lebih awal dengan jam palsu)', () => {
    expect(clampShadowStart(now - 30 * DAY_MS, now)).toBe(now - MAX_BACKDATE_MS);
  });
});

describe('buildShadowSummary', () => {
  const inc = (id: string, dayOffset: number, level: ShadowIncident['level'], rules: string[], status = 'OPEN'): ShadowIncident => ({
    id, level, status, start_ms: START + dayOffset * DAY_MS + 3_600_000, hits: rules.map((rule) => ({ rule })),
  });
  const now = START + 5 * DAY_MS + 3_600_000; // hari ke-6
  const state = shadowState(14, START, now);

  const incidents = [
    inc('a', 0, 'CRITICAL', ['R2', 'R3', 'R5']),
    inc('b', 1, 'MEDIUM', ['R18']),
    inc('c', 1, 'CRITICAL', ['R3', 'R3']),
    inc('d', 4, 'LOW', ['R1']),
    inc('e', 4, 'CRITICAL', ['R7'], 'RETRACTED'),
    inc('f', 5, 'CRITICAL', ['R3'], 'CONFIRMED_FRAUD'),
    inc('g', 5, 'CRITICAL', ['R2'], 'FALSE_ALARM'),
    inc('h', 5, 'MEDIUM', ['R18'], 'LEGIT'),
  ];
  const s = buildShadowSummary(incidents, state, now, 420);

  it('menghitung per tingkat tanpa insiden yang ditarik kembali', () => {
    expect(s.total).toBe(7);
    expect(s.byLevel).toEqual({ CRITICAL: 4, MEDIUM: 2, LOW: 1 });
  });

  it('per aturan = jumlah insiden yang memuatnya (aturan ganda dalam satu insiden dihitung sekali), terbanyak dulu', () => {
    expect(s.byRule.map((r) => [r.rule, r.incidents])).toEqual([['R3', 3], ['R18', 2], ['R2', 2], ['R1', 1], ['R5', 1]]);
    expect(s.byRule.find((r) => r.rule === 'R3')!.label).toBe('void setelah customer pergi');
  });

  it('per hari mengisi hari tanpa insiden dengan nol, dari hari pertama sampai hari ini', () => {
    expect(s.byDay.map((d) => d.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']);
    expect(s.byDay.map((d) => [d.total, d.critical])).toEqual([[1, 1], [2, 1], [0, 0], [0, 0], [1, 0], [3, 2]]);
  });

  it('kritis per minggu diperkirakan dari hari yang sudah lewat: 4 kritis dalam 5,04 hari ≈ 5,6 per minggu', () => {
    expect(s.criticalPerWeek).toBe(Math.round(((4 * 7) / ((now - START) / DAY_MS)) * 10) / 10);
    expect(s.criticalPerWeek).toBeCloseTo(5.6, 1);
  });

  it('belum cukup 3 hari data: tidak memperkirakan per minggu', () => {
    const early = START + 2 * DAY_MS;
    expect(buildShadowSummary(incidents.slice(0, 2), shadowState(14, START, early), early, 420).criticalPerWeek).toBeNull();
  });

  it('presisi kritis = dikonfirmasi / direview: 1 dari 2 kritis yang direview = 50%; review non-kritis tidak ikut', () => {
    expect(s.reviewed).toEqual({ total: 3, confirmed: 1, legit: 1, falseAlarm: 1, inconclusive: 0 });
    expect(s.criticalPrecision).toBe(50);
  });

  it('belum ada yang direview: presisi null (bukan 0%)', () => {
    expect(buildShadowSummary([inc('x', 0, 'CRITICAL', ['R2'])], state, now, 420).criticalPrecision).toBeNull();
  });

  it('menunggu aktivitas pertama: ringkasan kosong tanpa hari', () => {
    const pending = shadowState(14, null, now);
    expect(buildShadowSummary([], pending, now, 420)).toMatchObject({ total: 0, byDay: [], criticalPerWeek: null, criticalPrecision: null });
  });

  it('shadow yang sudah berakhir: hari berhenti di batas akhir, bukan sampai hari ini', () => {
    const later = START + 30 * DAY_MS;
    const ended = buildShadowSummary(incidents, shadowState(14, START, later), later, 420);
    expect(ended.byDay).toHaveLength(15); // 1 Okt .. 15 Okt (batas akhir jatuh pukul 09.00 hari ke-15)
    expect(ended.byDay.at(-1)!.date).toBe('2026-10-15');
  });

  it('hari mengikuti zona waktu outlet', () => {
    const utcState = shadowState(14, START, now);
    const day = buildShadowSummary([inc('z', 0, 'LOW', ['R1'])], utcState, now, 0).byDay[0]!.date;
    expect(day).toBe('2026-10-01'); // 09:00 WIB = 02:00 UTC, tanggal sama di UTC
  });
});
