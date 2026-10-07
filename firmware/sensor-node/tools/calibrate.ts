/**
 * Saran zona dan ambang sensor dari rekaman CSV (firmware dibangun dengan env esp32c3-calibrate).
 * Pemakaian:  npx tsx firmware/sensor-node/tools/calibrate.ts kosong.csv customer.csv [kasir.csv]
 *   kosong.csv    konter tanpa siapa pun (2–3 menit, termasuk saat ada orang lalu-lalang di kejauhan)
 *   customer.csv  customer berdiri di tempat membayar (mulai 3–5 orang bergantian, masing-masing ~20 detik)
 *   kasir.csv     hanya kasir bekerja di belakang konter, tanpa customer (3–5 menit)
 */
import { readFileSync } from 'node:fs';

export interface Row {
  ts: number;
  state: number;
  moveDist: number;
  moveEnergy: number;
  staticDist: number;
  staticEnergy: number;
}

export function parseCsv(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^CSV,(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)(?:,|$)/.exec(line.trim());
    if (!m) continue;
    const [ts, state, moveDist, moveEnergy, staticDist, staticEnergy] = m.slice(1).map(Number) as [number, number, number, number, number, number];
    rows.push({ ts, state, moveDist, moveEnergy, staticDist, staticEnergy });
  }
  return rows;
}

export const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i]!;
};
const sortedNums = (xs: number[]) => [...xs].sort((a, b) => a - b);

export interface Suggestion {
  zoneMin: number;
  zoneMax: number;
  moveEnergyMin: number;
  staticEnergyMin: number;
  warnings: string[];
  stats: { empty: number; customer: number; cashier: number | null; customerInZoneRate: number; cashierInZoneRate: number | null };
}

function inZone(r: Row, s: Pick<Suggestion, 'zoneMin' | 'zoneMax' | 'moveEnergyMin' | 'staticEnergyMin'>): boolean {
  if (r.state === 0) return false;
  const move = (r.state & 1) !== 0 && r.moveEnergy >= s.moveEnergyMin && r.moveDist >= s.zoneMin && r.moveDist <= s.zoneMax;
  const still = (r.state & 2) !== 0 && r.staticEnergy >= s.staticEnergyMin && r.staticDist >= s.zoneMin && r.staticDist <= s.zoneMax;
  return move || still;
}

/** Menurunkan zona dan ambang: derau diambil dari ruangan kosong, jarak dari customer, lalu diuji terhadap kasir sendirian. */
export function analyze(empty: Row[], customer: Row[], cashier?: Row[]): Suggestion {
  const warnings: string[] = [];
  const present = customer.filter((r) => r.state !== 0);
  if (present.length < 50) warnings.push('Rekaman customer terlalu sedikit (kurang dari 50 frame berisi target). Ulangi dengan customer berdiri di tempat membayar.');

  // Jarak customer: pakai target yang energinya lebih kuat pada frame itu.
  const dist = sortedNums(present.map((r) => (r.staticEnergy > r.moveEnergy ? r.staticDist : r.moveDist)).filter((d) => d > 0));
  const zoneMin = Math.max(10, Math.floor(percentile(dist, 5) - 15));
  const zoneMax = Math.min(600, Math.ceil(percentile(dist, 95) + 20));

  // Derau: energi tertinggi (p99) yang muncul saat ruangan kosong.
  const noiseMove = percentile(sortedNums(empty.filter((r) => r.state & 1).map((r) => r.moveEnergy)), 99);
  const noiseStatic = percentile(sortedNums(empty.filter((r) => r.state & 2).map((r) => r.staticEnergy)), 99);
  const sigMove = percentile(sortedNums(present.filter((r) => r.state & 1).map((r) => r.moveEnergy)), 10);
  const sigStatic = percentile(sortedNums(present.filter((r) => r.state & 2).map((r) => r.staticEnergy)), 10);

  const pick = (noise: number, signal: number, name: string): number => {
    const floor = Math.min(100, noise + 10);
    if (signal > 0 && floor >= signal) {
      warnings.push(`Sinyal ${name} customer (p10 = ${signal}) hampir sama dengan derau ruangan kosong (p99 = ${noise}). Pindahkan sensor lebih dekat atau ubah arahnya.`);
      return Math.max(15, Math.floor(signal * 0.8));
    }
    return Math.max(15, signal > 0 ? Math.min(floor, Math.floor(signal * 0.8)) : floor);
  };
  const moveEnergyMin = pick(noiseMove, sigMove, 'gerak');
  const staticEnergyMin = pick(noiseStatic, sigStatic, 'diam');

  const base = { zoneMin, zoneMax, moveEnergyMin, staticEnergyMin };
  const emptyFalse = empty.filter((r) => inZone(r, base)).length / Math.max(1, empty.length);
  if (emptyFalse > 0.01) warnings.push(`Ruangan kosong terdeteksi ada orang pada ${(emptyFalse * 100).toFixed(1)}% frame. Naikkan ambang atau periksa benda bergerak (kipas, tirai) di depan sensor.`);

  const customerRate = customer.filter((r) => inZone(r, base)).length / Math.max(1, customer.length);
  let cashierRate: number | null = null;
  if (cashier) {
    cashierRate = cashier.filter((r) => inZone(r, base)).length / Math.max(1, cashier.length);
    if (cashierRate > 0.05) {
      warnings.push(`Kasir sendirian terdeteksi di zona pada ${(cashierRate * 100).toFixed(0)}% frame. Sensor akan mengira ada customer. Geser/arahkan sensor menjauh dari posisi kasir atau kecilkan zona.`);
    }
  } else {
    warnings.push('Rekaman kasir sendirian tidak diberikan, jadi risiko kasir terdeteksi sebagai customer belum diuji.');
  }

  return {
    ...base, warnings,
    stats: { empty: empty.length, customer: customer.length, cashier: cashier?.length ?? null, customerInZoneRate: customerRate, cashierInZoneRate: cashierRate },
  };
}

export function formatSuggestion(s: Suggestion): string {
  return [
    '// Salin ke app/config.h',
    `#define ZONE_MIN_CM ${s.zoneMin}`,
    `#define ZONE_MAX_CM ${s.zoneMax}`,
    `#define MOVE_ENERGY_MIN ${s.moveEnergyMin}`,
    `#define STATIC_ENERGY_MIN ${s.staticEnergyMin}`,
    '',
    `Frame: kosong ${s.stats.empty}, customer ${s.stats.customer}${s.stats.cashier !== null ? `, kasir ${s.stats.cashier}` : ''}`,
    `Customer terdeteksi di zona: ${(s.stats.customerInZoneRate * 100).toFixed(0)}% frame`,
    ...(s.stats.cashierInZoneRate !== null ? [`Kasir terdeteksi di zona: ${(s.stats.cashierInZoneRate * 100).toFixed(1)}% frame`] : []),
    ...(s.warnings.length ? ['', 'PERHATIAN:', ...s.warnings.map((w) => `- ${w}`)] : []),
  ].join('\n');
}

if (process.argv[1]?.endsWith('calibrate.ts')) {
  const [empty, customer, cashier] = process.argv.slice(2);
  if (!empty || !customer) {
    console.error('pakai: calibrate.ts kosong.csv customer.csv [kasir.csv]');
    process.exit(2);
  }
  const read = (f: string) => parseCsv(readFileSync(f, 'utf8'));
  console.log(formatSuggestion(analyze(read(empty), read(customer), cashier ? read(cashier) : undefined)));
}
