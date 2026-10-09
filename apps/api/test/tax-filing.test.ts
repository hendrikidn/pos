import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { a1Xml, bpmpXml, nitku, pph21Deadlines, tin16, type A1Row, type BpmpRow } from '../src/coretax-pph21';
import { createHarness, type Harness } from './harness';

const FIX = resolve(__dirname, 'fixtures/coretax');
const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const HOUR = 3_600_000;
const hasXmllint = spawnSync('xmllint', ['--version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'coretax-'));

/** Memvalidasi XML terhadap XSD resmi DJP (diekstrak dari konverter Excel mereka). */
function validate(xsd: 'bpa1' | 'bpmp', xml: string): { ok: boolean; out: string } {
  const f = join(dir, `${Math.random().toString(36).slice(2)}.xml`);
  writeFileSync(f, xml);
  const r = spawnSync('xmllint', ['--noout', '--schema', join(FIX, `${xsd}.xsd`), f], { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}
const tags = (xml: string, parent: string) => {
  const block = new RegExp(`<${parent}>([\\s\\S]*?)</${parent}>`).exec(xml)![1]!;
  return [...block.matchAll(/<([A-Za-z0-9]+)[ />]/g)].map((m) => m[1]!);
};

const EMP = { npwp: '029482015507000', tkuSuffix: '000000' };
const bpmpRow = (over: Partial<BpmpRow> = {}): BpmpRow => ({ month: 10, year: 2026, foreign: false, passport: null, tin: '3175031412770017', ptkp: 'K/0', position: 'Kasir', taxObjectCode: '21-100-01', gross: 30_000_000, rate: 12, withholdingDate: '2026-10-31', ...over });
const a1Row = (over: Partial<A1Row> = {}): A1Row => ({ monthStart: 1, monthEnd: 12, year: 2026, foreign: false, passport: null, tin: '3175031412770017', ptkp: 'K/0', status: 'FullYear', position: 'Kasir', taxObjectCode: '21-100-01', numberOfMonths: 0, salary: 120_000_000, otherBenefit: 6_000_000, insurance: 960_000, pension: 1_200_000, withholdingDate: '2026-12-31', ...over });

describe.skipIf(!hasXmllint)('XML Coretax dibangun dari penggajian: sesuai skema resmi DJP', () => {
  it('contoh resmi DJP lolos XSD hasil ekstraksi (alat ukur sehat); XSD BPMP mencatat enum ECT yang berbeda dari contoh DJP sendiri (ETC)', () => {
    expect(validate('bpa1', readFileSync(join(FIX, 'bpa1-contoh-djp.xml'), 'utf8')).ok).toBe(true);
    const bpmp = validate('bpmp', readFileSync(join(FIX, 'bpmp-contoh-djp.xml'), 'utf8'));
    expect(bpmp.ok).toBe(false);
    expect(bpmp.out).toContain("'ETC'");
  });

  it('BPMP buatan kita lolos XSD; urutan elemen sama dengan contoh DJP; WNA memakai paspor; paspor WNI nil', () => {
    const xml = bpmpXml(EMP, [bpmpRow(), bpmpRow({ foreign: true, passport: 'X1234567', tin: '3273062212790005', rate: 0.75, gross: 7_000_000 })]);
    const v = validate('bpmp', xml);
    expect(v.ok, v.out).toBe(true);
    expect(tags(xml, 'MmPayroll')).toEqual(tags(readFileSync(join(FIX, 'bpmp-contoh-djp.xml'), 'utf8'), 'MmPayroll'));
    expect(xml).toContain('<TIN>0029482015507000</TIN>'); // NPWP 15 digit dijadikan 16 dengan awalan 0
    expect(xml).toContain('<CounterpartPassport xsi:nil="true"/>');
    expect(xml).toContain('<CounterpartOpt>Foreign</CounterpartOpt>');
    expect(xml).toContain('<CounterpartPassport>X1234567</CounterpartPassport>');
    expect(xml).toContain('<IDPlaceOfBusinessActivity>0029482015507000000000</IDPlaceOfBusinessActivity>');
    expect(xml).toContain('<Rate>0.75</Rate>');
  });

  it('BPA1 buatan kita lolos XSD untuk tiga status (FullYear, PartialYear, Annualized); urutan elemen sama dengan contoh DJP', () => {
    const xml = a1Xml(EMP, [a1Row(), a1Row({ status: 'PartialYear', monthStart: 3, monthEnd: 9, tin: '3578154612790001' }), a1Row({ status: 'Annualized', numberOfMonths: 2, monthStart: 5, monthEnd: 6, foreign: true, passport: 'AB123456', tin: '3275101001720010', ptkp: 'TK/0' })]);
    const v = validate('bpa1', xml);
    expect(v.ok, v.out).toBe(true);
    expect(tags(xml, 'A1')).toEqual(tags(readFileSync(join(FIX, 'bpa1-contoh-djp.xml'), 'utf8'), 'A1'));
    expect(xml).toContain('<Article21IncomeTax>0</Article21IncomeTax>'); // sesuai templat DJP
    expect(xml).toContain('<StatusOfWithholding>Annualized</StatusOfWithholding>');
  });

  it('karakter khusus di jabatan di-escape; nilai di luar skema (PTKP salah, tanggal rusak) ketahuan oleh XSD, jadi alat uji benar-benar memeriksa', () => {
    const ok = bpmpXml(EMP, [bpmpRow({ position: 'Kasir & "Barista" <A>' })]);
    expect(validate('bpmp', ok).ok).toBe(true);
    expect(ok).toContain('Kasir &amp; &quot;Barista&quot; &lt;A&gt;');
    expect(validate('bpmp', bpmpXml(EMP, [bpmpRow({ ptkp: 'XX/9' })])).ok).toBe(false);
    expect(validate('bpmp', bpmpXml(EMP, [bpmpRow({ withholdingDate: 'kemarin' })])).ok).toBe(false);
    expect(validate('bpmp', bpmpXml(EMP, [bpmpRow({ gross: 0 })])).ok).toBe(false); // bruto harus > 0
    expect(validate('bpmp', bpmpXml({ npwp: '12345', tkuSuffix: '000000' }, [bpmpRow()])).ok).toBe(false); // TIN pemotong harus 15–16 digit
  });
});

describe('pembantu pelaporan', () => {
  it('NPWP 15 digit dijadikan 16 digit; NITKU = 16 digit + 6 digit; batas waktu bulan Desember jatuh di Januari tahun berikutnya', () => {
    expect(tin16('029482015507000')).toBe('0029482015507000');
    expect(tin16('3175031412770017')).toBe('3175031412770017');
    expect(nitku({ npwp: '029482015507000', tkuSuffix: '000000' })).toBe('0029482015507000000000');
    expect(nitku({ npwp: '3175031412770017', tkuSuffix: '000001' })).toBe('3175031412770017000001');
    expect(pph21Deadlines(2026, 10)).toEqual({ pay: '2026-11-10', file: '2026-11-20' });
    expect(pph21Deadlines(2026, 12)).toEqual({ pay: '2027-01-10', file: '2027-01-20' });
  });
});

describe('pelaporan PPh 21 lewat API (BPMP, BPA1, rekap)', () => {
  let h: Harness;
  let owner: string;
  let manager: string;
  let ownerB: string;
  const post = (path: string, tok: string | undefined, body?: unknown) => h.http('POST', path, tok, body ?? {});
  const put = (path: string, tok: string, body: unknown) => h.http('PUT', path, tok, body);
  const get = (path: string, tok = owner) => h.http('GET', path, tok);

  async function work(staff: string, from: string, days: number) {
    h.setNow(WIB(`${from}T09:00:00`) + (days + 1) * 24 * HOUR);
    for (let i = 0; i < days; i++) {
      const start = WIB(`${from}T09:00:00`) + i * 24 * HOUR;
      expect((await post('/v1/outlets/o1/hr/attendance', owner, { staffId: staff, start, end: start + 8 * HOUR, reason: 'uji pelaporan' })).status).toBe(201);
    }
  }
  /** Membuat penggajian, memfinalkan, dan membayarnya di akhir periode. */
  async function paidRun(from: string, to: string, final: string[] = []) {
    h.setNow(WIB(`${to}T12:00:00`));
    const r = await post('/v1/outlets/o1/payroll-runs', owner, { from, to });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    for (const s of final) expect((await put(`/v1/payroll-runs/${r.body.id}/lines/${s}`, owner, { finalPeriod: true })).status).toBe(200);
    expect((await post(`/v1/payroll-runs/${r.body.id}/finalize`, owner)).status).toBe(201);
    expect((await post(`/v1/payroll-runs/${r.body.id}/pay`, owner, { date: to, method: 'TRANSFER' })).status).toBe(201);
    return r.body.id as number;
  }
  const tax = (path: string, tok = owner) => get(`/v1/hr/tax/${path}`, tok);
  const raw = (path: string, tok = owner) => h.raw(`/v1/hr/tax/${path}`, tok);

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-31T12:00:00'));
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    for (const [id, name, pin] of [['wati', 'Wati', '2468'], ['ana', 'Ana', '1357'], ['dian', 'Dian', '9753']]) expect((await post('/v1/staff', owner, { id, name, role: 'CASHIER', pin })).status).toBe(201);
    for (const id of ['wati', 'ana', 'dian']) expect((await put(`/v1/hr/pay/${id}`, owner, { payType: 'HOURLY', rate: 625_000 })).status).toBe(200);
    const on = { taxEnabled: true, ptkp: 'TK/0', npwp: true, bpjsTk: false, bpjsKes: false };
    expect((await put('/v1/hr/staff-tax/wati', owner, { ...on, nik: '3175031412770017', position: 'Kasir' })).status).toBe(200);
    expect((await put('/v1/hr/staff-tax/ana', owner, { ...on, ptkp: 'K/0', nik: '3275101001720010' })).status).toBe(200);
    expect((await put('/v1/hr/staff-tax/dian', owner, on)).status).toBe(200); // sengaja tanpa NIK
    // Oktober: Wati 1 hari (5 jt, TER 0%), Ana 6 hari (30 jt, K/0 TER A 12%), Dian 1 hari. November: Wati 1 hari. Desember: Wati 12 hari (masa pajak terakhir).
    await work('wati', '2026-10-05', 1); await work('ana', '2026-10-05', 6); await work('dian', '2026-10-05', 1);
    await work('wati', '2026-11-03', 1);
    await work('wati', '2026-12-02', 12);
  });
  afterAll(() => h.close());

  it('profil pemberi kerja: hanya OWNER; NPWP 15/16 digit; TKU 6 digit; nama wajib; tersimpan dan terbaca; tenant lain tidak melihat', async () => {
    expect((await get('/v1/hr/employer-tax', manager)).status).toBe(403);
    expect((await put('/v1/hr/employer-tax', manager, { npwp: '029482015507000', legalName: 'PT Kopi' })).status).toBe(403);
    for (const bad of [{ npwp: '123' }, { npwp: 'abcdefghijklmno' }, { npwp: '029482015507000', tkuSuffix: '12' }, { npwp: '029482015507000', legalName: '' }, { npwp: '029482015507000', legalName: 'PT', taxpayerType: 'X' }, { npwp: '029482015507000', legalName: 'PT Kopi', umkmFinal: 'ya' }]) {
      expect((await put('/v1/hr/employer-tax', owner, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await get('/v1/hr/employer-tax')).body.profile).toBeNull();
    expect((await put('/v1/hr/employer-tax', owner, { npwp: '02.948.201-5.507.000', legalName: 'PT Kopi Senopati', address: 'Jl. Senopati 1', signerName: 'Hendrik', signerTitle: 'Direktur' })).status).toBe(200);
    expect((await get('/v1/hr/employer-tax')).body.profile).toMatchObject({ npwp: '029482015507000', tkuSuffix: '000000', legalName: 'PT Kopi Senopati', umkmFinal: false, taxpayerType: 'OP' });
    expect((await get('/v1/hr/employer-tax', ownerB)).body.profile).toBeNull();
  });

  it('identitas pegawai: NIK 15/16 digit, jabatan maks. 50, paspor, bendera; ditolak bila tidak sah', async () => {
    const ok = { taxEnabled: true, ptkp: 'TK/0', npwp: true, bpjsTk: false, bpjsKes: false };
    for (const bad of [{ nik: '123' }, { nik: 'abc' }, { position: 'x'.repeat(51) }, { passport: '!!' }, { foreign: 'ya' }, { annualize: 1 }]) expect((await put('/v1/hr/staff-tax/dian', owner, { ...ok, ...bad })).status, JSON.stringify(bad)).toBe(400);
    const list = (await get('/v1/hr/staff-tax')).body as { id: string; nik: string; position: string; foreign: boolean; annualize: boolean }[];
    expect(list.find((s) => s.id === 'wati')).toMatchObject({ nik: '3175031412770017', position: 'Kasir', foreign: false, annualize: false });
    expect(list.find((s) => s.id === 'dian')!.nik).toBe('');
  });

  it('BPMP Oktober: baris per pegawai dengan bruto dan tarif TER; data belum lengkap = daftar masalah dan XML ditolak 400', async () => {
    await paidRun('2026-10-01', '2026-10-31');
    const r = (await tax('bpmp?year=2026&month=10')).body;
    expect(r.rows.map((x: { staffId: string }) => x.staffId)).toEqual(['ana', 'dian', 'wati']);
    expect(r.rows.find((x: { staffId: string }) => x.staffId === 'ana')).toMatchObject({ gross: 30_000_000, rate: 12, tax: 3_600_000, ptkp: 'K/0', month: 10, year: 2026, withholdingDate: '2026-10-31' });
    expect(r.rows.find((x: { staffId: string }) => x.staffId === 'wati')).toMatchObject({ gross: 5_000_000, rate: 0, tax: 0, position: 'Kasir' });
    expect(r.rows.find((x: { staffId: string }) => x.staffId === 'dian')).toMatchObject({ position: 'Kasir' }); // jabatan kosong: dari peran
    expect(r.problems).toEqual(['Dian: NIK/NPWP belum diisi atau tidak 15–16 digit']);
    expect(r.ready).toBe(false);
    expect(r.deadlines).toEqual({ pay: '2026-11-10', file: '2026-11-20' });
    expect(r.xml).toBeUndefined();
    const xml = await raw('bpmp?year=2026&month=10&format=xml');
    expect(xml.status).toBe(400);
    expect(xml.text).toContain('Dian');
  });

  it('setelah NIK dilengkapi: XML BPMP diunduh, sah menurut XSD DJP, dan unduhan tercatat di audit', async () => {
    const on = { taxEnabled: true, ptkp: 'TK/0', npwp: true, bpjsTk: false, bpjsKes: false };
    expect((await put('/v1/hr/staff-tax/dian', owner, { ...on, nik: '3578154612790001' })).status).toBe(200);
    expect((await tax('bpmp?year=2026&month=10')).body).toMatchObject({ ready: true, problems: [] });
    const x = await raw('bpmp?year=2026&month=10&format=xml');
    expect(x.status).toBe(200);
    expect(x.headers.get('content-type')).toContain('application/xml');
    expect(x.headers.get('content-disposition')).toContain('bpmp-2026-10.xml');
    expect(x.text).toContain('<Gross>30000000</Gross>');
    expect(x.text).toContain('<Rate>12</Rate>');
    expect(x.text).toContain('<TIN>0029482015507000</TIN>');
    if (hasXmllint) { const v = validate('bpmp', x.text); expect(v.ok, v.out).toBe(true); }
    expect(Number((await h.db.admin.query<{ n: string }>("select count(*) n from audit_log where action = 'export.coretax.bpmp'")).rows[0]!.n)).toBe(1);
    expect((await raw('bpmp?year=2026&month=10&format=xml', manager)).status).toBe(403);
    expect((await raw('bpmp?year=2026&month=10&format=xml', ownerB)).status).toBe(400); // tenant lain: tanpa profil dan tanpa pegawai
  });

  it('parameter tidak sah ditolak; bulan tanpa penggajian dibayar memberi peringatan, bukan galat', async () => {
    for (const q of ['year=2026&month=13', 'year=2026&month=0', 'year=2026&month=abc', 'year=20&month=1', 'month=1', 'year=2023&month=1']) expect((await tax(`bpmp?${q}`)).status, q).toBe(400);
    const empty = (await tax('bpmp?year=2026&month=3')).body;
    expect(empty.rows).toEqual([]);
    expect(empty.warnings[0]).toContain('Belum ada penggajian DIBAYAR');
    expect((await tax('bpmp?year=2026&month=3&format=xml').then((r) => r.status))).toBe(400);
  });

  it('hanya penggajian yang sudah DIBAYAR yang dilaporkan: yang masih final atau draf tidak muncul', async () => {
    h.setNow(WIB('2026-11-30T12:00:00'));
    const r = await post('/v1/outlets/o1/payroll-runs', owner, { from: '2026-11-01', to: '2026-11-30' });
    expect(r.status).toBe(201);
    expect((await tax('bpmp?year=2026&month=11')).body.rows).toEqual([]); // draf
    expect((await post(`/v1/payroll-runs/${r.body.id}/finalize`, owner)).status).toBe(201);
    expect((await tax('bpmp?year=2026&month=11')).body.rows).toEqual([]); // final, belum dibayar
    expect((await post(`/v1/payroll-runs/${r.body.id}/pay`, owner, { date: '2026-11-30', method: 'TRANSFER' })).status).toBe(201);
    expect((await tax('bpmp?year=2026&month=11')).body.rows.map((x: { staffId: string }) => x.staffId)).toEqual(['wati']);
  });

  it('masa pajak terakhir: Wati dikeluarkan dari BPMP Desember dan masuk BPA1; Ana dan Dian belum punya masa terakhir (peringatan)', async () => {
    await paidRun('2026-12-01', '2026-12-31', ['wati']);
    const dec = (await tax('bpmp?year=2026&month=12')).body;
    expect(dec.rows).toEqual([]);
    expect(dec.excluded).toEqual([{ staffId: 'wati', name: 'Wati', reason: 'masa pajak terakhir: gunakan BPA1' }]);
    const a1 = (await tax('a1?year=2026')).body;
    expect(a1.rows).toHaveLength(1);
    // Wati bulan Okt-Des (3 bulan): gaji 5 + 5 + 60 jt = 70 jt; tidak penuh setahun -> PartialYear
    expect(a1.rows[0]).toMatchObject({ staffId: 'wati', monthStart: 10, monthEnd: 12, year: 2026, status: 'PartialYear', numberOfMonths: 0, salary: 70_000_000, otherBenefit: 0, insurance: 0, pension: 0, withholdingDate: '2026-12-31', tin: '3175031412770017', ptkp: 'TK/0', withheld: 725_000 });
    expect(a1.pending.map((p: { name: string }) => p.name)).toEqual(['Ana', 'Dian']);
    expect(a1.warnings[0]).toContain('Ana, Dian');
    expect(a1.ready).toBe(true);
    const x = await raw('a1?year=2026&format=xml');
    expect(x.status).toBe(200);
    expect(x.headers.get('content-disposition')).toContain('bpa1-2026.xml');
    expect(x.text).toContain('<SalaryPensionJhtTht>70000000</SalaryPensionJhtTht>');
    if (hasXmllint) { const v = validate('bpa1', x.text); expect(v.ok, v.out).toBe(true); }
  });

  it('pegawai dengan penghitungan disetahunkan (annualize) diberi status Annualized dan jumlah bulan', async () => {
    expect((await put('/v1/hr/staff-tax/wati', owner, { taxEnabled: true, ptkp: 'TK/0', npwp: true, bpjsTk: false, bpjsKes: false, nik: '3175031412770017', position: 'Kasir', annualize: true })).status).toBe(200);
    expect((await tax('a1?year=2026')).body.rows[0]).toMatchObject({ status: 'Annualized', numberOfMonths: 3 });
    expect((await put('/v1/hr/staff-tax/wati', owner, { taxEnabled: true, ptkp: 'TK/0', npwp: true, bpjsTk: false, bpjsKes: false, nik: '3175031412770017', position: 'Kasir', annualize: false })).status).toBe(200);
  });

  it('rekap SPT Masa PPh 21: bruto dan PPh per bulan, termasuk bagian masa pajak terakhir, dengan batas waktu', async () => {
    const s = (await tax('pph21-summary?year=2026')).body;
    expect(s.months).toHaveLength(12);
    expect(s.months[9]).toMatchObject({ month: 10, staff: 3, gross: 5_000_000 + 30_000_000 + 5_000_000, pph21: 3_600_000, ofWhichFinalPeriod: 0, deadlines: { pay: '2026-11-10', file: '2026-11-20' } });
    expect(s.months[10]).toMatchObject({ month: 11, staff: 1, pph21: 0 });
    expect(s.months[11]).toMatchObject({ month: 12, staff: 1, gross: 60_000_000, pph21: 725_000, ofWhichFinalPeriod: 725_000, deadlines: { pay: '2027-01-10', file: '2027-01-20' } });
    expect(s.months[0]).toMatchObject({ staff: 0, pph21: 0 });
    expect(s.totalPph21).toBe(3_600_000 + 725_000);
    expect((await tax('pph21-summary?year=2026', manager)).status).toBe(403);
    expect((await tax('pph21-summary?year=abc')).status).toBe(400);
  });
});
