import { describe, expect, it } from 'vitest';
import { analyze, formatSuggestion, parseCsv, percentile, type Row } from '../tools/calibrate';

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const between = (a: number, b: number) => Math.round(a + rnd() * (b - a));

/** Frame palsu: `n` frame pada 10 Hz. */
function rows(n: number, make: () => Partial<Row>): Row[] {
  return Array.from({ length: n }, (_, i) => ({ ts: i * 100, state: 0, moveDist: 0, moveEnergy: 0, staticDist: 0, staticEnergy: 0, ...make() }));
}
const emptyRoom = () => rows(1500, () => (rnd() < 0.03 ? { state: 1, moveDist: between(200, 400), moveEnergy: between(5, 14) } : {}));
const customerAt = (lo: number, hi: number) =>
  rows(900, () => {
    const d = between(lo, hi);
    return { state: 3, moveDist: d, moveEnergy: between(45, 85), staticDist: d, staticEnergy: between(40, 75) };
  });

describe('parseCsv', () => {
  it('membaca baris CSV dan mengabaikan log lain', () => {
    const r = parseCsv('boot\nCSV,1000,3,80,60,82,55,1\nsesi: 10 s\nCSV,1100,0,0,0,0,0,0\r\n');
    expect(r).toEqual([
      { ts: 1000, state: 3, moveDist: 80, moveEnergy: 60, staticDist: 82, staticEnergy: 55 },
      { ts: 1100, state: 0, moveDist: 0, moveEnergy: 0, staticDist: 0, staticEnergy: 0 },
    ]);
  });
  it('percentile', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('analyze', () => {
  it('data bersih: zona membungkus jarak customer, ambang di atas derau dan di bawah sinyal, tanpa peringatan', () => {
    const cashier = rows(1500, () => (rnd() < 0.2 ? { state: 2, staticDist: between(190, 260), staticEnergy: between(35, 60) } : {}));
    const s = analyze(emptyRoom(), customerAt(60, 110), cashier);
    expect(s.zoneMin).toBeLessThanOrEqual(60);
    expect(s.zoneMin).toBeGreaterThanOrEqual(30);
    expect(s.zoneMax).toBeGreaterThanOrEqual(110);
    expect(s.zoneMax).toBeLessThan(160);
    expect(s.moveEnergyMin).toBeGreaterThan(14); // di atas derau ruangan kosong
    expect(s.moveEnergyMin).toBeLessThan(45); // di bawah sinyal customer
    expect(s.stats.customerInZoneRate).toBeGreaterThan(0.95);
    expect(s.stats.cashierInZoneRate).toBe(0);
    expect(s.warnings).toEqual([]);
  });

  it('kasir berdiri di dalam zona customer: diperingatkan', () => {
    const cashier = rows(1500, () => ({ state: 2, staticDist: between(70, 100), staticEnergy: between(40, 65) }));
    const s = analyze(emptyRoom(), customerAt(60, 110), cashier);
    expect(s.stats.cashierInZoneRate).toBeGreaterThan(0.5);
    expect(s.warnings.join(' ')).toMatch(/Kasir sendirian terdeteksi/);
  });

  it('tanpa rekaman kasir: ada catatan bahwa risiko belum diuji', () => {
    expect(analyze(emptyRoom(), customerAt(60, 110)).warnings.join(' ')).toMatch(/kasir sendirian tidak diberikan/i);
  });

  it('sinyal customer sama lemahnya dengan derau: diperingatkan', () => {
    const noisy = rows(1500, () => ({ state: 1, moveDist: between(60, 110), moveEnergy: between(30, 40) }));
    const weak = rows(900, () => ({ state: 1, moveDist: between(60, 110), moveEnergy: between(32, 42) }));
    expect(analyze(noisy, weak).warnings.join(' ')).toMatch(/hampir sama dengan derau/);
  });

  it('ruangan kosong yang sering terdeteksi (kipas, tirai) diperingatkan', () => {
    const fan = rows(1500, () => ({ state: 1, moveDist: between(70, 100), moveEnergy: between(50, 70) }));
    expect(analyze(fan, customerAt(60, 110)).warnings.join(' ')).toMatch(/Ruangan kosong terdeteksi/);
  });

  it('rekaman customer terlalu sedikit diperingatkan', () => {
    expect(analyze(emptyRoom(), customerAt(60, 110).slice(0, 20)).warnings.join(' ')).toMatch(/terlalu sedikit/);
  });

  it('keluaran siap salin berisi #define yang dipakai firmware', () => {
    const out = formatSuggestion(analyze(emptyRoom(), customerAt(60, 110)));
    for (const k of ['ZONE_MIN_CM', 'ZONE_MAX_CM', 'MOVE_ENERGY_MIN', 'STATIC_ENERGY_MIN']) expect(out).toContain(`#define ${k} `);
  });
});
