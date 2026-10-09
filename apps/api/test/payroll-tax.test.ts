import { describe, expect, it } from 'vitest';
import { TER_TABLES } from '../src/ter-tables';
import { computeBpjs, DEFAULT_TAX_SETTINGS as S, mergeSettings, pasal17, pph21Annual, pph21Monthly, ptkpAnnual, taxableGross, terCategory, terRate } from '../src/statutory';

describe('tabel TER (PMK 168/2023)', () => {
  it('jumlah lapisan sesuai lampiran (A 44, B 40, C 41), berurutan, tarif tidak pernah turun, diakhiri 34% tanpa batas', () => {
    expect(TER_TABLES.A).toHaveLength(44);
    expect(TER_TABLES.B).toHaveLength(40);
    expect(TER_TABLES.C).toHaveLength(41);
    for (const rows of Object.values(TER_TABLES)) {
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]![0]).toBeGreaterThan(rows[i - 1]![0]);
        expect(rows[i]![1]).toBeGreaterThanOrEqual(rows[i - 1]![1]);
      }
      expect(rows[0]).toEqual([rows[0]![0], 0]);
      expect(rows.at(-1)).toEqual([Infinity, 34]);
    }
  });

  it('batas pertama tiap kategori dan lapisan penting sesuai lampiran', () => {
    expect(TER_TABLES.A[0]![0]).toBe(5_400_000);
    expect(TER_TABLES.B[0]![0]).toBe(6_200_000);
    expect(TER_TABLES.C[0]![0]).toBe(6_600_000);
    expect(terRate('A', 5_400_000)).toBe(0);
    expect(terRate('A', 5_400_001)).toBe(0.25);
    expect(terRate('B', 6_200_000)).toBe(0);
    expect(terRate('B', 6_200_001)).toBe(0.25);
    expect(terRate('C', 6_600_001)).toBe(0.25);
    expect(terRate('A', 1_400_000_000)).toBe(33);
    expect(terRate('A', 1_400_000_001)).toBe(34);
    expect(terRate('B', 1_405_000_001)).toBe(34);
    expect(terRate('C', 1_419_000_001)).toBe(34);
  });

  it('kategori menurut status PTKP', () => {
    expect(['TK/0', 'TK/1', 'K/0'].map((s) => terCategory(s as never))).toEqual(['A', 'A', 'A']);
    expect(['TK/2', 'TK/3', 'K/1', 'K/2'].map((s) => terCategory(s as never))).toEqual(['B', 'B', 'B', 'B']);
    expect(terCategory('K/3')).toBe('C');
    expect(ptkpAnnual('TK/0')).toBe(54_000_000);
    expect(ptkpAnnual('K/0')).toBe(58_500_000);
    expect(ptkpAnnual('K/3')).toBe(72_000_000);
  });
});

describe('PPh 21 TER bulanan: contoh hitungan resmi DJP', () => {
  // Angka dari materi DJP tentang PMK 168/2023 (contoh Tuan A, B, D dan simulasi perbandingan).
  const m = (gross: number, st = 'TK/0' as const) => pph21Monthly(S, gross, st, true);
  it('simulasi TER A: 5.500.000 -> 0,25% = 13.750; 6.000.000 -> 0,75% = 45.000; 6.500.000 -> 1% = 65.000; 8.000.000 -> 1,5% = 120.000', () => {
    expect(m(5_500_000)).toMatchObject({ category: 'A', rate: 0.25, tax: 13_750 });
    expect(m(6_000_000)).toMatchObject({ rate: 0.75, tax: 45_000 });
    expect(m(6_500_000)).toMatchObject({ rate: 1, tax: 65_000 });
    expect(m(8_000_000)).toMatchObject({ rate: 1.5, tax: 120_000 });
  });
  it('Tuan B (TK/0, 15.500.000): 7% = 1.085.000; Tuan D (TK/0, 17.500.000): 8% = 1.400.000', () => {
    expect(m(15_500_000)).toMatchObject({ rate: 7, tax: 1_085_000 });
    expect(m(17_500_000)).toMatchObject({ rate: 8, tax: 1_400_000 });
  });
  it('Tuan A (K/0, bruto 30.080.000 / 35.080.000 / 50.080.000): 13% = 3.910.400; 14% = 4.911.200; 18% = 9.014.400', () => {
    expect(m(30_080_000, 'K/0' as never)).toMatchObject({ rate: 13, tax: 3_910_400 });
    expect(m(35_080_000, 'K/0' as never)).toMatchObject({ rate: 14, tax: 4_911_200 });
    expect(m(50_080_000, 'K/0' as never)).toMatchObject({ rate: 18, tax: 9_014_400 });
  });
  it('tanpa NPWP dipotong 20% lebih tinggi; kategori B dan C memakai tabelnya sendiri', () => {
    expect(pph21Monthly(S, 8_000_000, 'TK/0', false).tax).toBe(144_000); // 120.000 x 1,2
    expect(pph21Monthly(S, 6_300_000, 'K/1', true)).toMatchObject({ category: 'B', rate: 0.25 }); // B: 6.200.001-6.500.000
    expect(pph21Monthly(S, 6_300_000, 'TK/0', true)).toMatchObject({ category: 'A', rate: 0.75 });
    expect(pph21Monthly(S, 7_000_000, 'K/3', true)).toMatchObject({ category: 'C', rate: 0.5 });
  });
});

describe('PPh 21 setahun (masa pajak terakhir) dan Pasal 17', () => {
  it('lapisan Pasal 17: 5% sampai 60 juta, 15% sampai 250 juta, 25% sampai 500 juta, 30% sampai 5 miliar, 35% di atasnya', () => {
    expect(pasal17(0)).toBe(0);
    expect(pasal17(60_000_000)).toBe(3_000_000);
    expect(pasal17(250_000_000)).toBe(3_000_000 + 28_500_000);
    expect(pasal17(500_000_000)).toBe(3_000_000 + 28_500_000 + 62_500_000);
    expect(pasal17(5_000_000_000)).toBe(94_000_000 + 1_350_000_000);
    expect(pasal17(5_000_001_000)).toBe(94_000_000 + 1_350_000_000 + 350);
  });

  it('Tuan A (K/0, bruto setahun 450.960.000, iuran pensiun 1.200.000): biaya jabatan 6 juta, PTKP 58,5 juta, PKP 385.260.000, pajak 65.315.000', () => {
    // 450.960.000 - 6.000.000 - 1.200.000 - 58.500.000 = 385.260.000 ; 3.000.000 + 28.500.000 + 25% x 135.260.000 = 65.315.000
    const r = pph21Annual(S, { grossYear: 450_960_000, months: 12, status: 'K/0', npwp: true, employeePensionYear: 1_200_000 });
    expect(r).toMatchObject({ biayaJabatan: 6_000_000, ptkp: 58_500_000, pkp: 385_260_000 });
    expect(r.tax).toBe(3_000_000 + 28_500_000 + 33_815_000);
  });

  it('bekerja sebagian tahun: PTKP dan batas biaya jabatan sebanding dengan bulan (8 bulan, TK/0, 17,5 juta/bulan, iuran pensiun 100 ribu)', () => {
    // bruto 140.000.000; biaya jabatan min(7.000.000; 8 x 500.000 = 4.000.000) = 4.000.000; PTKP 54.000.000 x 8/12 = 36.000.000; PKP = 99.200.000
    const r = pph21Annual(S, { grossYear: 140_000_000, months: 8, status: 'TK/0', npwp: true, employeePensionYear: 800_000 });
    expect(r).toMatchObject({ biayaJabatan: 4_000_000, ptkp: 36_000_000, pkp: 99_200_000 });
    expect(r.tax).toBe(3_000_000 + 5_880_000); // 5% x 60 juta + 15% x 39,2 juta
  });

  it('PKP dibulatkan ke bawah ke ribuan; penghasilan di bawah PTKP tidak kena pajak; tanpa NPWP 120%', () => {
    expect(pph21Annual(S, { grossYear: 100_000_999, months: 12, status: 'TK/0', npwp: true, employeePensionYear: 0 }).pkp % 1000).toBe(0);
    expect(pph21Annual(S, { grossYear: 50_000_000, months: 12, status: 'TK/0', npwp: true, employeePensionYear: 0 })).toMatchObject({ pkp: 0, tax: 0 });
    const a = pph21Annual(S, { grossYear: 120_000_000, months: 12, status: 'TK/0', npwp: true, employeePensionYear: 0 });
    const b = pph21Annual(S, { grossYear: 120_000_000, months: 12, status: 'TK/0', npwp: false, employeePensionYear: 0 });
    expect(b.tax).toBe(Math.floor(a.tax * 1.2));
  });
});

describe('BPJS dan penghasilan bruto', () => {
  it('upah 8.000.000, TK dan Kesehatan: JHT 2%/3,7%, JP 1%/2%, JKK 0,24%, JKM 0,3%, Kesehatan 1%/4%', () => {
    expect(computeBpjs(S, 8_000_000, { tk: true, kes: true })).toEqual({
      jhtEmployee: 160_000, jhtEmployer: 296_000, jpEmployee: 80_000, jpEmployer: 160_000, jkkEmployer: 19_200, jkmEmployer: 24_000, kesEmployee: 80_000, kesEmployer: 320_000,
    });
  });

  it('batas upah: JP dan Kesehatan dipotong di batasnya, JHT tidak ada batas', () => {
    const b = computeBpjs(S, 20_000_000, { tk: true, kes: true });
    expect(b.jhtEmployee).toBe(400_000); // 2% x 20.000.000
    expect(b.jpEmployee).toBe(105_474); // 1% x 10.547.400
    expect(b.jpEmployer).toBe(210_948);
    expect(b.kesEmployee).toBe(120_000); // 1% x 12.000.000
    expect(b.kesEmployer).toBe(480_000);
  });

  it('bendera mati = tidak ada iuran; hanya Kesehatan; hanya TK', () => {
    expect(Object.values(computeBpjs(S, 8_000_000, { tk: false, kes: false })).every((v) => v === 0)).toBe(true);
    const k = computeBpjs(S, 8_000_000, { tk: false, kes: true });
    expect(k.kesEmployee).toBe(80_000);
    expect(k.jhtEmployee).toBe(0);
    const t = computeBpjs(S, 8_000_000, { tk: true, kes: false });
    expect(t.kesEmployer).toBe(0);
    expect(t.jhtEmployee).toBe(160_000);
  });

  it('bruto PPh 21 memuat JKK, JKM, dan Kesehatan pemberi kerja (contoh DJP: premi JKK 0,5% + JKM 0,3% dari gaji = 80.000 pada gaji 10 juta)', () => {
    const s = { ...S, jkk: 0.5, jkm: 0.3 };
    const b = computeBpjs(s, 10_000_000, { tk: true, kes: false });
    expect(b.jkkEmployer + b.jkmEmployer).toBe(80_000);
    expect(taxableGross(s, { base: 10_000_000, overtime: 0, allowance: 20_000_000 }, b)).toBe(30_080_000); // angka bruto Januari di contoh DJP
    expect(taxableGross({ ...s, employerPremiumsTaxable: false }, { base: 10_000_000, overtime: 0, allowance: 20_000_000 }, b)).toBe(30_000_000);
  });
});

describe('pengaturan', () => {
  it('menggabungkan nilai yang sah dan menolak yang di luar batas, kunci tak dikenal, dan tipe salah', () => {
    expect(mergeSettings(S, { jpWageCap: 11_000_000, jkk: 0.54 })).toMatchObject({ ok: true, value: { jpWageCap: 11_000_000, jkk: 0.54, jhtEmployee: 2 } });
    for (const bad of [{ jkk: -1 }, { jkk: 21 }, { jkk: 'x' }, { jpWageCap: 1.5 }, { jpWageCap: -1 }, { employerPremiumsTaxable: 'ya' }, { noNpwpMultiplier: 0.5 }, { lain: 1 }, null, [], 'x']) {
      expect(mergeSettings(S, bad).ok).toBe(false);
    }
  });
});
