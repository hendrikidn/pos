import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { DEFAULT_ACCOUNTS, type Account, type JournalEntry } from '../src/accounting';
import { balanceSheet, buildStatements, cashFlow, equityStatement, isCashAccount, statementCsv } from '../src/financial-statements';
import { createHarness, type Harness } from './harness';

const ACCOUNTS: Account[] = [...DEFAULT_ACCOUNTS, { code: '1-2100', name: 'Peralatan', type: 'ASSET', normal: 'DEBIT' }, { code: '2-2100', name: 'Pinjaman bank', type: 'LIABILITY', normal: 'CREDIT' }];
const e = (ref: string, date: string, ...lines: [string, number, number][]): JournalEntry => ({ ref, date, memo: ref, source: 'MANUAL', lines: lines.map(([account, debit, credit]) => ({ account, debit, credit })) });

/**
 * Pembukuan yang bisa dihitung manual (juta rupiah). Awal: modal 50 jt masuk bank, beli stok 10 jt, penjualan tunai 11 jt (10 + PBJT 1) di akhir 2025.
 * Januari 2026: penjualan tunai 22, penjualan QRIS 5,5 yang disetor 5,4 (komisi 0,1), sewa 3, HPP 8, pindah kas 20 ke bank, prive 5, setor PBJT 1, beli peralatan 4.
 */
const ENTRIES: JournalEntry[] = [
  e('modal', '2025-12-15', ['1-1300', 50_000_000, 0], ['3-1000', 0, 50_000_000]),
  e('stok', '2025-12-20', ['1-1400', 10_000_000, 0], ['1-1300', 0, 10_000_000]),
  e('jual-2025', '2025-12-31', ['1-1100', 11_000_000, 0], ['4-1000', 0, 10_000_000], ['2-1200', 0, 1_000_000]),
  e('jual-tunai', '2026-01-10', ['1-1100', 22_000_000, 0], ['4-1000', 0, 20_000_000], ['2-1200', 0, 2_000_000]),
  e('jual-qris', '2026-01-12', ['1-1200', 5_500_000, 0], ['4-1000', 0, 5_000_000], ['2-1200', 0, 500_000]),
  e('setor-qris', '2026-01-14', ['1-1300', 5_400_000, 0], ['6-5100', 100_000, 0], ['1-1200', 0, 5_500_000]),
  e('sewa', '2026-01-15', ['6-2000', 3_000_000, 0], ['1-1300', 0, 3_000_000]),
  e('hpp', '2026-01-20', ['5-1000', 8_000_000, 0], ['1-1400', 0, 8_000_000]),
  e('pindah-kas', '2026-01-25', ['1-1300', 20_000_000, 0], ['1-1100', 0, 20_000_000]),
  e('prive', '2026-01-28', ['3-1000', 5_000_000, 0], ['1-1300', 0, 5_000_000]),
  e('setor-pbjt', '2026-01-30', ['2-1200', 1_000_000, 0], ['1-1300', 0, 1_000_000]),
  e('alat', '2026-01-31', ['1-2100', 4_000_000, 0], ['1-1300', 0, 4_000_000]),
];
const M = (n: number) => Math.round(n * 1_000_000);

describe('neraca', () => {
  const b = balanceSheet(ENTRIES, ACCOUNTS, '2026-01-31', '2026-01-01');
  it('aset, kewajiban, dan ekuitas sesuai hitungan manual, dan seimbang', () => {
    expect(b.assets.current.rows.map((r) => [r.account, r.amount])).toEqual([['1-1100', M(13)], ['1-1300', M(52.4)], ['1-1400', M(2)]]); // piutang digital sudah nol: tidak tampil
    expect(b.assets.current.total).toBe(M(67.4));
    expect(b.assets.nonCurrent.rows).toEqual([{ account: '1-2100', name: 'Peralatan', amount: M(4) }]);
    expect(b.assets.total).toBe(M(71.4));
    expect(b.liabilities.current.rows).toEqual([{ account: '2-1200', name: 'Utang Pajak Restoran (PBJT)', amount: M(2.5) }]);
    expect(b.liabilities.total).toBe(M(2.5));
    // modal 50 - prive 5 = 45 ; laba ditahan (2025) 10 ; laba 2026 = 25 - 11,1 = 13,9
    expect(b.equity.rows).toEqual([
      { account: '3-1000', name: 'Modal Pemilik', amount: M(45) },
      { account: '', name: 'Laba ditahan (tahun-tahun sebelumnya)', amount: M(10) },
      { account: '', name: 'Laba (rugi) tahun berjalan', amount: M(13.9) },
    ]);
    expect(b.equity.total).toBe(M(68.9));
    expect(b.totalLiabilitiesAndEquity).toBe(M(71.4));
    expect(b.difference).toBe(0);
  });

  it('per tanggal lebih awal: hanya jurnal sampai tanggal itu; akhir 2025 laba masih "tahun berjalan"', () => {
    const old = balanceSheet(ENTRIES, ACCOUNTS, '2025-12-31', '2025-01-01');
    expect(old.assets.total).toBe(M(61));
    expect(old.equity.rows.find((r) => r.name.includes('tahun berjalan'))?.amount).toBe(M(10));
    expect(old.equity.rows.some((r) => r.name.includes('ditahan'))).toBe(false);
    expect(old.difference).toBe(0);
    expect(balanceSheet([], ACCOUNTS, '2026-01-31', '2026-01-01')).toMatchObject({ difference: 0, assets: { total: 0 } });
  });

  it('akun kontra aset (akumulasi penyusutan, kredit-normal) mengurangi aset; kewajiban jangka panjang terpisah', () => {
    const more = [...ENTRIES, e('susut', '2026-01-31', ['6-4000', 100_000, 0], ['1-2200', 0, 100_000]), e('utang', '2026-01-31', ['1-1300', 8_000_000, 0], ['2-2100', 0, 8_000_000])];
    const acc: Account[] = [...ACCOUNTS, { code: '1-2200', name: 'Akumulasi penyusutan', type: 'ASSET', normal: 'CREDIT' }];
    const b2 = balanceSheet(more, acc, '2026-01-31', '2026-01-01');
    expect(b2.assets.nonCurrent.total).toBe(M(4) - 100_000);
    expect(b2.liabilities.longTerm.rows[0]).toMatchObject({ account: '2-2100', amount: M(8) });
    expect(b2.difference).toBe(0);
  });
});

describe('arus kas (metode langsung)', () => {
  const c = cashFlow(ENTRIES, ACCOUNTS, '2026-01-01', '2026-01-31');
  it('kas awal, operasi, investasi, pendanaan, dan kas akhir sesuai hitungan manual', () => {
    expect(c.openingCash).toBe(M(51));
    // operasi: penjualan +20, PBJT dipungut +2 (tunai) ; piutang digital +5,5 ; komisi -0,1 ; sewa -3 ; setor PBJT -1
    const op = Object.fromEntries(c.operating.rows.map((r) => [r.account, r.amount]));
    expect(op).toEqual({ '1-1200': M(5.5), '2-1200': M(2) - M(1), '4-1000': M(20), '6-2000': -M(3), '6-5100': -M(0.1) });
    expect(c.operating.total).toBe(M(23.4));
    expect(c.investing.rows).toEqual([{ account: '1-2100', name: 'Peralatan', amount: -M(4) }]);
    expect(c.financing.rows).toEqual([{ account: '3-1000', name: 'Modal Pemilik', amount: -M(5) }]);
    expect(c.netChange).toBe(M(14.4));
    expect(c.closingCash).toBe(M(65.4));
    expect(c.reconciles).toBe(true);
  });

  it('kas akhir sama dengan kas dan bank di neraca; pemindahan kas ke bank tidak muncul; penjualan QRIS baru masuk saat disetor', () => {
    const b = balanceSheet(ENTRIES, ACCOUNTS, '2026-01-31', '2026-01-01');
    const cashInBs = b.assets.current.rows.filter((r) => isCashAccount(r.account)).reduce((s, r) => s + r.amount, 0);
    expect(c.closingCash).toBe(cashInBs);
    expect(c.operating.rows.some((r) => r.account === '1-1100' || r.account === '1-1300')).toBe(false);
    const before = cashFlow(ENTRIES, ACCOUNTS, '2026-01-01', '2026-01-13'); // QRIS sudah dijual tetapi belum disetor
    expect(before.operating.rows.find((r) => r.account === '1-1200')).toBeUndefined();
    expect(before.operating.total).toBe(M(22));
  });

  it('periode tanpa kas: nol, kas awal = akhir; pinjaman (pendanaan jangka panjang) masuk pendanaan', () => {
    expect(cashFlow(ENTRIES, ACCOUNTS, '2026-02-01', '2026-02-28')).toMatchObject({ netChange: 0, openingCash: M(65.4), closingCash: M(65.4), reconciles: true });
    const loan = [...ENTRIES, e('utang', '2026-01-31', ['1-1300', 8_000_000, 0], ['2-2100', 0, 8_000_000])];
    expect(cashFlow(loan, ACCOUNTS, '2026-01-01', '2026-01-31').financing.rows.find((r) => r.account === '2-2100')?.amount).toBe(M(8));
  });
});

describe('perubahan ekuitas dan paket laporan', () => {
  it('ekuitas awal + modal + laba = ekuitas akhir, cocok dengan neraca', () => {
    const q = equityStatement(ENTRIES, ACCOUNTS, '2026-01-01', '2026-01-31', '2026-01-01');
    expect(q).toMatchObject({ opening: M(60), contributions: -M(5), netIncome: M(13.9), closing: M(68.9), reconciles: true });
  });

  it('paket lengkap: laba rugi periode, peringatan utang PBJT dan catatan, semua saling cocok', () => {
    const s = buildStatements(ENTRIES, ACCOUNTS, { from: '2026-01-01', to: '2026-01-31' }, '2025-12-15');
    expect(s.incomeStatement).toMatchObject({ totalRevenue: M(25), totalExpenses: M(11.1), netIncome: M(13.9) });
    expect(s.trialBalanceBalanced).toBe(true);
    expect(s.balanceSheet.difference).toBe(0);
    expect(s.cashFlow.reconciles && s.equity.reconciles).toBe(true);
    expect(s.equity.closing).toBe(s.balanceSheet.equity.total);
    expect(s.warnings.some((w) => w.includes('Utang PBJT'))).toBe(true);
    expect(buildStatements([], ACCOUNTS, { from: '2026-01-01', to: '2026-01-31' }, null).warnings[0]).toContain('Belum ada jurnal');
  });

  it('jurnal tidak seimbang atau akun tidak dikenal ketahuan lewat selisih/peringatan', () => {
    const bad = [...ENTRIES, e('rusak', '2026-01-31', ['1-1100', 1_000, 0])];
    const s = buildStatements(bad, ACCOUNTS, { from: '2026-01-01', to: '2026-01-31' }, null);
    expect(s.balanceSheet.difference).toBe(1_000);
    expect(s.trialBalanceBalanced).toBe(false);
    expect(s.warnings[0]).toContain('tidak seimbang');
  });

  it('CSV tiap laporan: BOM, judul, dan total sesuai', () => {
    const s = buildStatements(ENTRIES, ACCOUNTS, { from: '2026-01-01', to: '2026-01-31' }, null);
    const csv = (k: 'balance' | 'income' | 'cashflow' | 'equity') => statementCsv(s, k).csv.slice(1).trim().split('\r\n');
    expect(statementCsv(s, 'balance').csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv('balance')).toContain('TOTAL ASET,71400000');
    expect(csv('balance')).toContain('TOTAL KEWAJIBAN DAN EKUITAS,71400000');
    expect(csv('income')).toContain('LABA (RUGI) BERSIH,13900000');
    expect(csv('cashflow')).toContain('Kas dan bank akhir,65400000');
    expect(csv('equity')).toContain('Ekuitas akhir,68900000');
  });
});

describe('laporan keuangan lewat API', () => {
  let h: Harness;
  let owner: string;
  let manager: string;
  let ops: string;
  let ownerB: string;
  let term: string;
  const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
  const get = (path: string, tok = owner) => h.http('GET', path, tok);
  const entry = (outlet: string, date: string, lines: unknown[]) => h.http('POST', `/v1/outlets/${outlet}/accounting/journal`, owner, { date, memo: 'uji', lines });

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-31T20:00:00'));
    await h.admin.createTenant('t1', 'T1');
    await h.admin.createTenant('t2', 'T2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t1', 'o2', 'Outlet 2');
    await h.admin.createOutlet('t2', 'ox', 'X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    // Penjualan tunai tiga hari di dua bulan (subtotal 100.000, PBJT 10.000) lewat event kasir.
    const s = new Sim('o1', '2026-09-30', 'term-1', 'sensor-1');
    for (const [day, id] of [['2026-09-29', 'a'], ['2026-09-30', 'b'], ['2026-10-02', 'c']] as const) {
      s.pos({ type: 'order.created', payload: { orderId: id, orderType: 'TAKE_AWAY' } }, WIB(`${day}T10:00:00`), 'budi');
      s.pos({ type: 'bill.printed', payload: { orderId: id, total: 110_000, breakdown: { subtotal: 100_000, discount: 0, service: 0, tax: 10_000, rounding: 0 } } }, WIB(`${day}T10:01:00`), 'budi');
      s.pos({ type: 'payment.received', payload: { orderId: id, method: 'CASH', amount: 110_000 } }, WIB(`${day}T10:02:00`), 'budi');
    }
    expect((await h.postEvents(term, s.events)).status).toBe(201);
    // Modal awal di outlet 1 dan sewa di outlet 2 (jurnal manual).
    expect((await entry('o1', '2026-09-01', [{ account: '1-1300', debit: 5_000_000 }, { account: '3-1000', credit: 5_000_000 }])).status).toBe(201);
    expect((await entry('o2', '2026-10-05', [{ account: '6-2000', debit: 200_000 }, { account: '1-1100', credit: 200_000 }])).status).toBe(201);
  });
  afterAll(() => h.close());

  it('hak akses: OWNER dan MANAGER per outlet; konsolidasi hanya OWNER; OPS, terminal, dan tenant lain ditolak', async () => {
    const p = '/accounting/statements?from=2026-10-01&to=2026-10-31';
    expect((await get(`/v1/outlets/o1${p}`, owner)).status).toBe(200);
    expect((await get(`/v1/outlets/o1${p}`, manager)).status).toBe(200);
    expect((await get(`/v1/outlets/all${p}`, manager)).status).toBe(403);
    expect((await get(`/v1/outlets/all${p}`, owner)).status).toBe(200);
    for (const tok of [ops, term]) expect((await get(`/v1/outlets/o1${p}`, tok)).status).toBe(403);
    expect((await get(`/v1/outlets/o1${p}`, ownerB)).status).toBeGreaterThanOrEqual(400);
    expect((await get(`/v1/outlets/ox${p}`, owner)).status).toBeGreaterThanOrEqual(400);
    expect((await h.http('GET', `/v1/outlets/o1${p}`)).status).toBe(401);
    for (const bad of ['?from=2026-13-01', '?to=2026-11-30', '?from=2026-10-31&to=2026-10-01', '?from=2025-01-01&to=2026-10-31', '?to=abc']) expect((await get(`/v1/outlets/o1/accounting/statements${bad}`)).status).toBe(400);
  });

  it('satu outlet: kas kumulatif lintas bulan (Sep + Okt), laba bulan ini vs laba ditahan, semua laporan cocok', async () => {
    const r = (await get('/v1/outlets/o1/accounting/statements?from=2026-10-01&to=2026-10-31')).body;
    // Kas: 3 x 110.000 = 330.000 ; Bank 5.000.000 ; PBJT 30.000 ; laba = 3 x 100.000 = 300.000 (semua 2026, jadi "tahun berjalan")
    const rows = Object.fromEntries(r.balanceSheet.assets.current.rows.map((x: { account: string; amount: number }) => [x.account, x.amount]));
    expect(rows).toEqual({ '1-1100': 330_000, '1-1300': 5_000_000 });
    expect(r.balanceSheet.liabilities.current.rows[0]).toMatchObject({ account: '2-1200', amount: 30_000 });
    expect(r.balanceSheet.equity.total).toBe(5_300_000);
    expect(r.balanceSheet.difference).toBe(0);
    expect(r.incomeStatement.totalRevenue).toBe(100_000); // hanya penjualan 2 Okt di periode
    expect(r.cashFlow.openingCash).toBe(5_220_000); // 5.000.000 + 2 x 110.000
    expect(r.cashFlow.netChange).toBe(110_000);
    expect(r.cashFlow.closingCash).toBe(5_330_000);
    expect(r.cashFlow.reconciles && r.equity.reconciles && r.trialBalanceBalanced).toBe(true);
    expect(r.equity).toMatchObject({ opening: 5_200_000, contributions: 0, netIncome: 100_000, closing: 5_300_000 });
    expect(r.booksStart).toBe('2026-09-01');
  });

  it('konsolidasi semua outlet menjumlahkan jurnal kedua outlet (sewa outlet 2 mengurangi kas dan laba)', async () => {
    const r = (await get('/v1/outlets/all/accounting/statements?from=2026-10-01&to=2026-10-31')).body;
    expect(r.balanceSheet.assets.total).toBe(5_330_000 - 200_000);
    expect(r.incomeStatement).toMatchObject({ totalRevenue: 100_000, totalExpenses: 200_000, netIncome: -100_000 });
    expect(r.balanceSheet.difference).toBe(0);
    expect(r.warnings.some((w: string) => w.includes('Konsolidasi 2 outlet'))).toBe(true);
    const o2 = (await get('/v1/outlets/o2/accounting/statements?from=2026-10-01&to=2026-10-31')).body;
    expect(o2.balanceSheet.assets.total).toBe(-200_000); // outlet 2 hanya punya sewa: kas negatif dan ekuitas negatif; tetap seimbang
    expect(o2.balanceSheet.difference).toBe(0);
  });

  it('CSV: statement wajib dikenal; berkas bernama; tercatat di audit', async () => {
    expect((await get('/v1/outlets/o1/accounting/statements?format=csv&statement=lain')).status).toBe(400);
    const csv = await h.raw('/v1/outlets/o1/accounting/statements?format=csv&statement=balance&to=2026-10-31', owner);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-disposition')).toContain('o1-neraca-2026-10-01_2026-10-31.csv');
    expect(csv.text).toContain('TOTAL ASET,5330000');
    expect(Number((await h.db.admin.query<{ n: string }>("select count(*) n from audit_log where action = 'report.statements'")).rows[0]!.n)).toBeGreaterThanOrEqual(4);
  });

  it('outlet tanpa data menghasilkan laporan kosong yang seimbang, bukan kesalahan', async () => {
    await h.admin.createOutlet('t1', 'o3', 'Outlet 3');
    const r = await get('/v1/outlets/o3/accounting/statements?from=2026-10-01&to=2026-10-31');
    expect(r.status).toBe(200);
    expect(r.body.balanceSheet).toMatchObject({ difference: 0, assets: { total: 0 } });
    expect(r.body.booksStart).toBeNull();
    expect(r.body.warnings[0]).toContain('Belum ada jurnal');
  });
});
