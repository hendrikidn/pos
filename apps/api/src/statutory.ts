import { TER_TABLES } from './ter-tables';

/**
 * Potongan wajib penggajian: PPh Pasal 21 (tarif efektif bulanan TER per PMK 168/2023, dan penghitungan setahun untuk masa pajak terakhir
 * dengan tarif Pasal 17) dan iuran BPJS Ketenagakerjaan serta Kesehatan. Murni. Semua tarif dan batas bisa diatur per tenant (`TaxSettings`)
 * karena batas upah BPJS berubah tiap tahun. Ini alat bantu hitung, bukan nasihat pajak: konfirmasi ke konsultan pajak sebelum menyetor.
 */

export const PTKP_STATUSES = ['TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3'] as const;
export type PtkpStatus = (typeof PTKP_STATUSES)[number];

/** PTKP setahun (Rp) menurut status; sama dengan yang tercantum di materi DJP untuk kategori TER. */
const PTKP: Record<PtkpStatus, number> = { 'TK/0': 54_000_000, 'TK/1': 58_500_000, 'TK/2': 63_000_000, 'TK/3': 67_500_000, 'K/0': 58_500_000, 'K/1': 63_000_000, 'K/2': 67_500_000, 'K/3': 72_000_000 };
export const ptkpAnnual = (s: PtkpStatus): number => PTKP[s];

/** TER A: TK/0, TK/1, K/0. TER B: TK/2, TK/3, K/1, K/2. TER C: K/3. */
export function terCategory(s: PtkpStatus): 'A' | 'B' | 'C' {
  if (s === 'TK/0' || s === 'TK/1' || s === 'K/0') return 'A';
  if (s === 'K/3') return 'C';
  return 'B';
}

/** Tarif TER (persen) untuk penghasilan bruto sebulan. */
export function terRate(cat: 'A' | 'B' | 'C', monthlyGross: number): number {
  for (const [hi, rate] of TER_TABLES[cat]) if (monthlyGross <= hi) return rate;
  return TER_TABLES[cat].at(-1)![1];
}

/** Lapisan tarif Pasal 17 ayat (1) huruf a UU PPh: [batas atas Penghasilan Kena Pajak, tarif]. */
const PASAL_17: [number, number][] = [[60_000_000, 0.05], [250_000_000, 0.15], [500_000_000, 0.25], [5_000_000_000, 0.30], [Infinity, 0.35]];

export function pasal17(pkp: number): number {
  let tax = 0;
  let lower = 0;
  for (const [upper, rate] of PASAL_17) {
    if (pkp <= lower) break;
    tax += (Math.min(pkp, upper) - lower) * rate;
    lower = upper;
  }
  return Math.floor(tax);
}

export interface TaxSettings {
  /** Persentase iuran (angka persen, mis. 2 = 2%). */
  jhtEmployee: number; jhtEmployer: number; jpEmployee: number; jpEmployer: number; jkk: number; jkm: number; kesEmployee: number; kesEmployer: number;
  /** Batas atas upah dasar iuran (Rp per bulan). JP berubah tiap tahun (sejak Maret 2025: Rp10.547.400); Kesehatan Rp12.000.000. JHT tanpa batas. */
  jpWageCap: number; kesWageCap: number;
  /** Biaya jabatan: 5% dari penghasilan bruto, maksimal Rp500.000 per bulan. */
  biayaJabatanPercent: number; biayaJabatanCapMonthly: number;
  /** Premi JKK, JKM, dan Kesehatan yang dibayar pemberi kerja ikut penghasilan bruto untuk PPh 21 (contoh DJP memasukkan JKK dan JKM). */
  employerPremiumsTaxable: boolean;
  /** Pengali tarif bila tanpa NPWP (120%). */
  noNpwpMultiplier: number;
}

export const DEFAULT_TAX_SETTINGS: TaxSettings = {
  jhtEmployee: 2, jhtEmployer: 3.7, jpEmployee: 1, jpEmployer: 2, jkk: 0.24, jkm: 0.3, kesEmployee: 1, kesEmployer: 4,
  jpWageCap: 10_547_400, kesWageCap: 12_000_000, biayaJabatanPercent: 5, biayaJabatanCapMonthly: 500_000, employerPremiumsTaxable: true, noNpwpMultiplier: 1.2,
};

const PERCENT_KEYS = ['jhtEmployee', 'jhtEmployer', 'jpEmployee', 'jpEmployer', 'jkk', 'jkm', 'kesEmployee', 'kesEmployer', 'biayaJabatanPercent'] as const;
const AMOUNT_KEYS = ['jpWageCap', 'kesWageCap', 'biayaJabatanCapMonthly'] as const;

/** Menggabungkan masukan ke pengaturan baku dengan pemeriksaan batas wajar. */
export function mergeSettings(base: TaxSettings, input: unknown): { ok: true; value: TaxSettings } | { ok: false; message: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, message: 'pengaturan harus berupa objek' };
  const v: TaxSettings = { ...base };
  const raw = input as Record<string, unknown>;
  for (const k of Object.keys(raw)) {
    if (![...PERCENT_KEYS, ...AMOUNT_KEYS, 'employerPremiumsTaxable', 'noNpwpMultiplier'].includes(k)) return { ok: false, message: `pengaturan "${k}" tidak dikenal` };
  }
  for (const k of PERCENT_KEYS) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== 'number' || !Number.isFinite(raw[k]) || (raw[k] as number) < 0 || (raw[k] as number) > 20) return { ok: false, message: `${k} harus angka persen 0–20` };
    v[k] = Math.round((raw[k] as number) * 100) / 100;
  }
  for (const k of AMOUNT_KEYS) {
    if (raw[k] === undefined) continue;
    if (!Number.isInteger(raw[k]) || (raw[k] as number) < 0 || (raw[k] as number) > 1_000_000_000) return { ok: false, message: `${k} harus bilangan bulat rupiah ≥ 0` };
    v[k] = raw[k] as number;
  }
  if (raw['employerPremiumsTaxable'] !== undefined) {
    if (typeof raw['employerPremiumsTaxable'] !== 'boolean') return { ok: false, message: 'employerPremiumsTaxable harus true atau false' };
    v.employerPremiumsTaxable = raw['employerPremiumsTaxable'];
  }
  if (raw['noNpwpMultiplier'] !== undefined) {
    const m = raw['noNpwpMultiplier'];
    if (typeof m !== 'number' || m < 1 || m > 2) return { ok: false, message: 'noNpwpMultiplier harus 1–2' };
    v.noNpwpMultiplier = m;
  }
  return { ok: true, value: v };
}

export interface Bpjs { jhtEmployee: number; jpEmployee: number; kesEmployee: number; jhtEmployer: number; jpEmployer: number; jkkEmployer: number; jkmEmployer: number; kesEmployer: number }

/**
 * Iuran BPJS dari upah dasar (gaji pokok + tunjangan tetap; lembur tidak termasuk). `tk`: peserta BPJS Ketenagakerjaan, `kes`: BPJS Kesehatan.
 * JP dan Kesehatan memakai batas upah; dibulatkan ke rupiah terdekat.
 */
export function computeBpjs(s: TaxSettings, basis: number, flags: { tk: boolean; kes: boolean }): Bpjs {
  const pct = (amount: number, p: number) => Math.round((amount * p) / 100);
  const z: Bpjs = { jhtEmployee: 0, jpEmployee: 0, kesEmployee: 0, jhtEmployer: 0, jpEmployer: 0, jkkEmployer: 0, jkmEmployer: 0, kesEmployer: 0 };
  if (flags.tk) {
    const jpBase = Math.min(basis, s.jpWageCap);
    z.jhtEmployee = pct(basis, s.jhtEmployee); z.jhtEmployer = pct(basis, s.jhtEmployer);
    z.jpEmployee = pct(jpBase, s.jpEmployee); z.jpEmployer = pct(jpBase, s.jpEmployer);
    z.jkkEmployer = pct(basis, s.jkk); z.jkmEmployer = pct(basis, s.jkm);
  }
  if (flags.kes) {
    const kBase = Math.min(basis, s.kesWageCap);
    z.kesEmployee = pct(kBase, s.kesEmployee); z.kesEmployer = pct(kBase, s.kesEmployer);
  }
  return z;
}

/** Penghasilan bruto untuk PPh 21 dari komponen gaji dan premi yang dibayar pemberi kerja. */
export function taxableGross(s: TaxSettings, components: { base: number; overtime: number; allowance: number }, b: Bpjs): number {
  const premiums = s.employerPremiumsTaxable ? b.jkkEmployer + b.jkmEmployer + b.kesEmployer : 0;
  return components.base + components.overtime + components.allowance + premiums;
}

/** PPh 21 satu masa pajak dengan TER: bruto sebulan × tarif kategori (dibulatkan ke bawah), lebih tinggi bila tanpa NPWP. */
export function pph21Monthly(s: TaxSettings, monthlyGross: number, status: PtkpStatus, npwp: boolean): { category: 'A' | 'B' | 'C'; rate: number; tax: number } {
  const category = terCategory(status);
  const rate = terRate(category, monthlyGross);
  const tax = Math.floor((monthlyGross * rate) / 100 * (npwp ? 1 : s.noNpwpMultiplier) + 1e-9);
  return { category, rate, tax };
}

/**
 * PPh 21 setahun untuk masa pajak terakhir (Desember, atau bulan berhenti bekerja): (bruto setahun - biaya jabatan - iuran pensiun/JHT/JP yang
 * dibayar pegawai - PTKP) dengan tarif Pasal 17. `months` = jumlah bulan bekerja di tahun itu; PTKP dan batas biaya jabatan dihitung sebanding.
 * Penghasilan Kena Pajak dibulatkan ke bawah ke ribuan penuh. Hasilnya total setahun; yang dipotong di masa terakhir = ini dikurangi yang sudah dipotong.
 */
export function pph21Annual(s: TaxSettings, p: { grossYear: number; months: number; status: PtkpStatus; npwp: boolean; employeePensionYear: number }): { biayaJabatan: number; ptkp: number; pkp: number; tax: number } {
  const months = Math.min(12, Math.max(1, p.months));
  const biayaJabatan = Math.min(Math.floor((p.grossYear * s.biayaJabatanPercent) / 100), s.biayaJabatanCapMonthly * months);
  const ptkp = Math.round((ptkpAnnual(p.status) * months) / 12);
  const pkp = Math.max(0, Math.floor((p.grossYear - biayaJabatan - p.employeePensionYear - ptkp) / 1000) * 1000);
  const tax = Math.floor(pasal17(pkp) * (p.npwp ? 1 : s.noNpwpMultiplier) + 1e-9);
  return { biayaJabatan, ptkp, pkp, tax };
}
