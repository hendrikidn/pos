import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const HOUR = 3_600_000;

describe('potongan wajib penggajian (PPh 21 TER dan BPJS)', () => {
  let h: Harness;
  let owner: string;
  let manager: string;
  let ownerB: string;
  const post = (path: string, tok: string | undefined, body?: unknown) => h.http('POST', path, tok, body ?? {});
  const put = (path: string, tok: string, body: unknown) => h.http('PUT', path, tok, body);
  const get = (path: string, tok = owner) => h.http('GET', path, tok);

  /** Menambah `days` hari kerja 8 jam berturut-turut mulai tanggal `from` (koreksi manual, supaya tidak perlu event absen). */
  async function work(staff: string, from: string, days: number, outlet = 'o1') {
    h.setNow(WIB(`${from}T09:00:00`) + (days + 1) * 24 * HOUR); // koreksi manual tidak boleh di masa depan
    for (let i = 0; i < days; i++) {
      const start = WIB(`${from}T09:00:00`) + i * 24 * HOUR;
      const r = await post(`/v1/outlets/${outlet}/hr/attendance`, owner, { staffId: staff, start, end: start + 8 * HOUR, reason: 'uji penggajian' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  }
  const run = async (from: string, to: string, now: string, outlet = 'o1') => {
    h.setNow(WIB(`${now}T12:00:00`));
    const r = await post(`/v1/outlets/${outlet}/payroll-runs`, owner, { from, to });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  };
  const line = async (id: number, staff: string) => (await get(`/v1/payroll-runs/${id}`)).body.lines.find((l: { staffId: string }) => l.staffId === staff);

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-31T12:00:00'));
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t1', 'o2', 'Outlet 2', { terminals: ['term-2'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    for (const [id, name] of [['andi', 'Andi'], ['budi', 'Budi'], ['sari', 'Sari']]) expect((await post('/v1/staff', owner, { id, name, role: 'CASHIER', pin: id === 'andi' ? '4827' : id === 'budi' ? '5930' : '7351' })).status).toBe(201);
  });
  afterAll(() => h.close());

  it('profil pajak: hanya OWNER; status PTKP harus dikenal; staf harus ada; pengaturan tarif dibatasi dan tercatat di audit', async () => {
    const ok = { taxEnabled: true, ptkp: 'K/0', npwp: true, bpjsTk: true, bpjsKes: true };
    expect((await put('/v1/hr/staff-tax/andi', manager, ok)).status).toBe(403);
    expect((await get('/v1/hr/staff-tax', manager)).status).toBe(403);
    expect((await put('/v1/hr/staff-tax/andi', owner, { ...ok, ptkp: 'K/9' })).status).toBe(400);
    expect((await put('/v1/hr/staff-tax/andi', owner, { ...ok, npwp: 'ya' })).status).toBe(400);
    expect((await put('/v1/hr/staff-tax/hantu', owner, ok)).status).toBe(404);
    expect((await put('/v1/hr/staff-tax/andi', owner, ok)).status).toBe(200);
    expect((await get('/v1/hr/staff-tax')).body.find((s: { id: string }) => s.id === 'andi')).toMatchObject({ taxEnabled: true, ptkp: 'K/0', bpjsTk: true });
    expect((await get('/v1/hr/staff-tax')).body.find((s: { id: string }) => s.id === 'budi')).toMatchObject({ taxEnabled: false, ptkp: 'TK/0', bpjsTk: false });
    expect((await get('/v1/hr/staff-tax', ownerB)).body).toEqual([]); // tenant lain
    expect((await put('/v1/hr/tax-settings', manager, { jpWageCap: 11_000_000 })).status).toBe(403);
    expect((await put('/v1/hr/tax-settings', owner, { jkk: 99 })).status).toBe(400);
    expect((await put('/v1/hr/tax-settings', owner, { lain: 1 })).status).toBe(400);
    expect((await get('/v1/hr/tax-settings')).body.settings).toMatchObject({ jpWageCap: 10_547_400, jhtEmployee: 2 });
    expect((await h.db.admin.query("select 1 from audit_log where action = 'staff.tax'")).rowCount).toBe(1);
  });

  it('bulanan: bruto = gaji + tunjangan + premi pemberi kerja; TER kategori A; BPJS karyawan dipotong; gaji bersih dan CSV setoran', async () => {
    expect((await put('/v1/hr/pay/andi', owner, { payType: 'MONTHLY', rate: 30_000_000 })).status).toBe(200);
    await work('andi', '2026-10-01', 1);
    const id = await run('2026-10-01', '2026-10-31', '2026-10-31');
    const l = await line(id, 'andi');
    // upah dasar 30.000.000: JHT 2% = 600.000 ; JP 1% x 10.547.400 = 105.474 ; Kesehatan 1% x 12.000.000 = 120.000
    expect(l.bpjsEmployee).toEqual({ jht: 600_000, jp: 105_474, kes: 120_000 });
    // pemberi kerja: JHT 3,7% = 1.110.000 ; JP 2% = 210.948 ; JKK 0,24% = 72.000 ; JKM 0,3% = 90.000 ; Kesehatan 4% = 480.000
    expect(l.bpjsEmployer).toEqual({ jht: 1_110_000, jp: 210_948, jkk: 72_000, jkm: 90_000, kes: 480_000 });
    // bruto PPh = 30.000.000 + JKK 72.000 + JKM 90.000 + Kesehatan 480.000 = 30.642.000 -> TER A 13% (30.050.001-32.400.000) = 3.983.460
    expect(l.taxableGross).toBe(30_642_000);
    expect(l).toMatchObject({ terCategory: 'A', terRate: 13, pph21: 3_983_460, finalPeriod: false });
    expect(l.net).toBe(30_000_000 - 3_983_460 - 600_000 - 105_474 - 120_000);
    const d = (await get(`/v1/payroll-runs/${id}`)).body;
    expect(d.statutory).toEqual({ pph21: 3_983_460, bpjsEmployee: 825_474, bpjsEmployer: 1_962_948 });
    const csv = await h.raw(`/v1/payroll-runs/${id}/export-statutory`, owner);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Andi,30642000,A,13,,3983460,600000,105474,120000,1110000,210948,72000,90000,480000');
    expect(csv.text).toContain('TOTAL,30642000,,,,3983460,600000,105474,120000,1110000,210948,72000,90000,480000');
    expect((await h.raw(`/v1/payroll-runs/${id}/export-statutory`, manager)).status).toBe(403);
  });

  it('jurnal gaji seimbang: Dr gaji kotor + beban BPJS pemberi kerja; Cr kas/bank bersih, utang PPh 21, utang BPJS', async () => {
    const id = Number((await get('/v1/payroll-runs')).body[0].id);
    expect((await post(`/v1/payroll-runs/${id}/finalize`, owner)).status).toBe(201);
    expect((await post(`/v1/payroll-runs/${id}/pay`, owner, { date: '2026-10-31', method: 'TRANSFER' })).status).toBe(201);
    const j = (await get('/v1/outlets/o1/accounting/journal?from=2026-10-01&to=2026-10-31')).body.entries.find((e: { ref: string }) => e.ref === `JU-GAJI-${id}`);
    const by = Object.fromEntries(j.lines.map((x: { account: string; debit: number; credit: number }) => [x.account, x.debit - x.credit]));
    const net = 30_000_000 - 3_983_460 - 825_474;
    expect(by['6-1000']).toBe(net + 3_983_460 + 825_474); // = 30.000.000 gaji kotor
    expect(by['6-1100']).toBe(1_962_948);
    expect(by['1-1300']).toBe(-net);
    expect(by['2-1400']).toBe(-3_983_460);
    expect(by['2-1500']).toBe(-(825_474 + 1_962_948));
    expect(j.lines.reduce((s: number, x: { debit: number }) => s + x.debit, 0)).toBe(j.lines.reduce((s: number, x: { credit: number }) => s + x.credit, 0));
  });

  it('staf tanpa profil pajak: tidak ada potongan, hasil sama dengan sebelum fitur ini', async () => {
    expect((await put('/v1/hr/pay/sari', owner, { payType: 'HOURLY', rate: 50_000 })).status).toBe(200);
    await work('sari', '2026-09-01', 2);
    const id = await run('2026-09-01', '2026-09-30', '2026-09-30');
    const l = await line(id, 'sari');
    expect(l).toMatchObject({ base: 800_000, pph21: 0, taxableGross: 800_000, terCategory: null, net: 800_000 });
    expect(l.bpjsEmployee).toEqual({ jht: 0, jp: 0, kes: 0 });
  });

  it('beberapa penggajian dalam satu bulan: TER atas bruto sebulan penuh, yang sudah dipotong dikurangkan', async () => {
    expect((await put('/v1/hr/staff-tax/budi', owner, { taxEnabled: true, ptkp: 'TK/0', npwp: true, bpjsTk: false, bpjsKes: false })).status).toBe(200);
    expect((await put('/v1/hr/pay/budi', owner, { payType: 'HOURLY', rate: 125_000 })).status).toBe(200);
    await work('budi', '2026-08-01', 6, 'o2'); // 48 jam x 125.000 = 6.000.000
    const a = await run('2026-08-01', '2026-08-10', '2026-08-10', 'o2');
    expect(await line(a, 'budi')).toMatchObject({ taxableGross: 6_000_000, terCategory: 'A', terRate: 0.75, pph21: 45_000 });
    await work('budi', '2026-08-11', 4, 'o2'); // +32 jam = 4.000.000 -> bulan ini 10.000.000
    const b = await run('2026-08-11', '2026-08-31', '2026-08-31', 'o2');
    // 10.000.000 jatuh di lapisan 9.650.001-10.050.000 = 2% = 200.000 ; sudah dipotong 45.000
    const l = await line(b, 'budi');
    expect(l).toMatchObject({ taxableGross: 4_000_000, terRate: 2, pph21: 155_000 });
    expect(l.taxNote).toContain('TER 2%');
  });

  it('masa pajak terakhir (Desember): pajak setahun tarif Pasal 17 dengan PTKP penuh, dikurangi yang sudah dipotong', async () => {
    expect((await post('/v1/staff', owner, { id: 'wati', name: 'Wati', role: 'CASHIER', pin: '2468' })).status).toBe(201);
    expect((await put('/v1/hr/staff-tax/wati', owner, { taxEnabled: true, ptkp: 'TK/0', npwp: true, bpjsTk: false, bpjsKes: false })).status).toBe(200);
    expect((await put('/v1/hr/pay/wati', owner, { payType: 'HOURLY', rate: 625_000 })).status).toBe(200);
    // Oktober dan November masing-masing 1 hari x 8 jam x 625.000 = 5.000.000 (TER A sampai 5.400.000 = 0%); Desember 12 hari = 60.000.000
    await work('wati', '2026-10-05', 1, 'o2');
    const oct = await run('2026-10-01', '2026-10-31', '2026-10-31', 'o2');
    expect(await line(oct, 'wati')).toMatchObject({ taxableGross: 5_000_000, terRate: 0, pph21: 0 });
    await work('wati', '2026-11-03', 1, 'o2');
    const nov = await run('2026-11-01', '2026-11-30', '2026-11-30', 'o2');
    expect((await line(nov, 'wati')).pph21).toBe(0);
    await work('wati', '2026-12-02', 12, 'o2');
    const dec = await run('2026-12-01', '2026-12-31', '2026-12-31', 'o2');
    const l = await line(dec, 'wati');
    // setahun: bruto 5 + 5 + 60 = 70.000.000 ; 3 bulan ; biaya jabatan min(3.500.000; 3 x 500.000 = 1.500.000) = 1.500.000 ; neto 68.500.000
    // PTKP TK/0 SETAHUN PENUH 54.000.000 (kewajiban subjektif ada sejak awal tahun) ; PKP 14.500.000 ; pajak 5% = 725.000 ; belum ada yang dipotong
    expect(l.finalPeriod).toBe(true);
    expect(l.pph21).toBe(725_000);
    expect(l.terCategory).toBeNull();
    expect(l.taxNote).toContain('Masa pajak terakhir');
    expect(l.taxNote).toContain('3 bulan');
  });

  it('bendera masa pajak terakhir manual dan hitung ulang mengikuti tunjangan; lebih potong tidak menghasilkan potongan negatif', async () => {
    expect((await post('/v1/staff', owner, { id: 'tono', name: 'Tono', role: 'CASHIER', pin: '1357' })).status).toBe(201);
    expect((await put('/v1/hr/staff-tax/tono', owner, { taxEnabled: true, ptkp: 'TK/0', npwp: true, bpjsTk: false, bpjsKes: false })).status).toBe(200);
    expect((await put('/v1/hr/pay/tono', owner, { payType: 'HOURLY', rate: 125_000 })).status).toBe(200);
    await work('tono', '2026-03-02', 2, 'o2'); // 16 jam = 2.000.000
    const id = await run('2026-03-01', '2026-03-31', '2026-03-31', 'o2');
    expect(await line(id, 'tono')).toMatchObject({ taxableGross: 2_000_000, terRate: 0, pph21: 0 });
    // tunjangan menaikkan bruto -> TER ikut naik (7.000.000 ada di lapisan 6.750.001-7.500.000 = 1,25%)
    expect((await put(`/v1/payroll-runs/${id}/lines/tono`, owner, { allowance: 5_000_000 })).status).toBe(200);
    expect(await line(id, 'tono')).toMatchObject({ taxableGross: 7_000_000, terRate: 1.25, pph21: 87_500 });
    // ditandai masa pajak terakhir: setahun dengan PTKP penuh. 7.000.000 - biaya jabatan 350.000 = 6.650.000 < PTKP 54.000.000 -> PKP 0 -> tidak ada pajak
    expect((await put(`/v1/payroll-runs/${id}/lines/tono`, owner, { finalPeriod: true })).status).toBe(200);
    expect(await line(id, 'tono')).toMatchObject({ finalPeriod: true, pph21: 0 });
    expect((await put(`/v1/payroll-runs/${id}/lines/tono`, owner, { finalPeriod: 'ya' })).status).toBe(400);
    expect((await put(`/v1/payroll-runs/${id}/lines/tono`, manager, { allowance: 1 })).status).toBe(403);
    // kembali bukan masa terakhir, lalu bulan Mei ditandai terakhir: pajak setahun 0 padahal Maret sudah dipotong 87.500 -> lebih potong, bukan negatif
    expect((await put(`/v1/payroll-runs/${id}/lines/tono`, owner, { finalPeriod: false })).status).toBe(200);
    expect((await line(id, 'tono')).pph21).toBe(87_500);
    await work('tono', '2026-05-04', 1, 'o2'); // 1.000.000
    const may = await run('2026-05-01', '2026-05-31', '2026-05-31', 'o2');
    expect((await put(`/v1/payroll-runs/${may}/lines/tono`, owner, { finalPeriod: true })).status).toBe(200);
    const m = await line(may, 'tono');
    expect(m.pph21).toBe(0);
    expect(m.net).toBe(m.base);
    expect(m.taxNote).toContain('LEBIH POTONG Rp 87.500');
  });

  it('pengaturan tersimpan mengubah hitungan berikutnya (batas upah JP) dan tanpa NPWP dipotong 120%', async () => {
    expect((await put('/v1/hr/tax-settings', owner, { jpWageCap: 5_000_000 })).status).toBe(200);
    expect((await put('/v1/hr/staff-tax/andi', owner, { taxEnabled: true, ptkp: 'K/0', npwp: false, bpjsTk: true, bpjsKes: false })).status).toBe(200);
    await work('andi', '2026-06-01', 1);
    const id = await run('2026-06-01', '2026-06-30', '2026-06-30');
    const l = await line(id, 'andi');
    expect(l.bpjsEmployee.jp).toBe(50_000); // 1% x batas baru 5.000.000
    expect(l.bpjsEmployee.kes).toBe(0);
    // bruto = 30.000.000 + JKK 72.000 + JKM 90.000 (tanpa Kesehatan) = 30.162.000 -> 13% = 3.921.060 -> x 1,2 = 4.705.272
    expect(l.taxableGross).toBe(30_162_000);
    expect(l.pph21).toBe(4_705_272);
  });
});
