import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const DAY = '2026-10-02';

describe('akuntansi', () => {
  let h: Harness;
  let owner: string;
  let manager: string;
  let ops: string;
  let ownerB: string;
  let term: string;

  const j = (q = '', tok = owner, outlet = 'o1') => h.http('GET', `/v1/outlets/${outlet}/accounting/journal${q}`, tok);
  const entry = (body: unknown, tok = owner, outlet = 'o1') => h.http('POST', `/v1/outlets/${outlet}/accounting/journal`, tok, body);
  const lines = (amount: number, debit = '6-2000', credit = '1-1100') => [{ account: debit, debit: amount }, { account: credit, credit: amount }];

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-03T09:00:00'));
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t1', 'o1b', 'Outlet 1B');
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    const s = new Sim('o1', DAY, 'term-1', 'sensor-1');
    s.pos({ type: 'order.created', payload: { orderId: 'a', orderType: 'DINE_IN' } }, '10:00:00', 'budi');
    s.pos({ type: 'bill.printed', payload: { orderId: 'a', total: 104_500, breakdown: { subtotal: 100_000, discount: 10_000, service: 5_000, tax: 9_500, rounding: 0 } } }, '10:01:00', 'budi');
    s.pos({ type: 'payment.received', payload: { orderId: 'a', method: 'CASH', amount: 54_500 } }, '10:02:00', 'budi');
    s.pos({ type: 'payment.received', payload: { orderId: 'a', method: 'QRIS', amount: 50_000, tid: '12345678' } }, '10:03:00', 'budi');
    s.pos({ type: 'order.created', payload: { orderId: 'v', orderType: 'TAKE_AWAY' } }, '11:00:00', 'sari');
    s.pos({ type: 'payment.received', payload: { orderId: 'v', method: 'CASH', amount: 77_000 } }, '11:01:00', 'sari');
    s.pos({ type: 'void.approved', payload: { orderId: 'v', reasonCode: 'WRONG_ORDER', approverIds: ['hendra'], amount: 77_000 } }, '11:05:00', 'sari');
    expect((await h.postEvents(term, s.events)).status).toBe(201);
  });
  afterAll(() => h.close());

  it('bagan akun bawaan terisi saat pertama dibuka; OWNER dan MANAGER boleh membaca, OPS dan terminal tidak', async () => {
    const r = await h.http('GET', '/v1/accounting/accounts', manager);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(21);
    expect(r.body.find((a: { code: string }) => a.code === '4-2000')).toMatchObject({ name: 'Diskon Penjualan', type: 'REVENUE', normal: 'DEBIT', active: true });
    expect((await h.http('GET', '/v1/accounting/accounts', ops)).status).toBe(403);
    expect((await h.http('GET', '/v1/accounting/accounts', term)).status).toBe(403);
    expect((await h.http('GET', '/v1/accounting/accounts')).status).toBe(401);
    expect((await h.http('GET', '/v1/accounting/accounts', owner)).body).toHaveLength(21); // tidak terisi dua kali
  });

  it('jurnal penjualan POS dihitung dari event dan seimbang; order void tidak dibukukan', async () => {
    const r = await j('?from=2026-10-02&to=2026-10-02');
    expect(r.status).toBe(200);
    expect(r.body.entries).toHaveLength(1);
    const e = r.body.entries[0];
    expect(e).toMatchObject({ ref: 'JU-POS-o1-20261002', date: DAY, source: 'POS' });
    const byAcc = Object.fromEntries(e.lines.map((l: { account: string; debit: number; credit: number }) => [l.account, [l.debit, l.credit]]));
    expect(byAcc).toEqual({ '1-1100': [54_500, 0], '1-1200': [50_000, 0], '4-1000': [0, 100_000], '4-2000': [10_000, 0], '4-1100': [0, 5_000], '2-1200': [0, 9_500] });
    expect(e.lines.reduce((s: number, l: { debit: number }) => s + l.debit, 0)).toBe(e.lines.reduce((s: number, l: { credit: number }) => s + l.credit, 0));
    expect((await j('?from=2026-10-01&to=2026-10-01')).body.entries).toEqual([]);
  });

  it('jurnal manual: seimbang, akun ada dan aktif, tanggal sah dan tidak di masa depan, keterangan wajib; hanya OWNER', async () => {
    const ok = await entry({ date: DAY, memo: 'Bayar sewa Oktober', lines: lines(3_000_000) });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ ref: expect.stringMatching(/^JM-\d+$/) });
    for (const [bad, why] of [
      [{ date: DAY, memo: 'x', lines: lines(100) }, 'keterangan'],
      [{ date: DAY, memo: 'Sewa', lines: [{ account: '6-2000', debit: 100 }, { account: '1-1100', credit: 90 }] }, 'seimbang'],
      [{ date: DAY, memo: 'Sewa', lines: lines(100, '9-9999') }, 'tidak ada'],
      [{ date: '2026-10-04', memo: 'Sewa', lines: lines(100) }, 'masa depan'],
      [{ date: '2026-13-01', memo: 'Sewa', lines: lines(100) }, 'YYYY-MM-DD'],
      [{ date: DAY, memo: 'Sewa', lines: [{ account: '6-2000', debit: 100 }] }, 'dua baris'],
      [{ date: DAY, memo: 'Sewa', lines: [{ account: '6-2000', debit: 100, credit: 100 }, { account: '1-1100', credit: 0 }] }, 'salah satu'],
    ] as const) {
      const r = await entry(bad);
      expect(r.status, why).toBe(400);
      expect(JSON.stringify(r.body)).toContain(why);
    }
    expect((await entry({ date: DAY, memo: 'Sewa', lines: lines(100) }, manager)).status).toBe(403);
    expect((await entry({ date: DAY, memo: 'Sewa', lines: lines(100) }, term)).status).toBe(403);
    const list = await j('?from=2026-10-02&to=2026-10-02');
    expect(list.body.entries.map((x: { ref: string }) => x.ref)).toEqual(['JM-1', 'JU-POS-o1-20261002'].sort());
    expect(list.body.manual).toEqual([{ id: 1, ref: 'JM-1', date: DAY, memo: 'Bayar sewa Oktober', createdBy: 'owner-1', voided: false, voidReason: null }]);
  });

  it('neraca saldo seimbang dan laba rugi memuat penjualan, diskon, dan sewa; PBJT bukan pendapatan', async () => {
    const r = await h.http('GET', '/v1/outlets/o1/accounting/reports?from=2026-10-02&to=2026-10-02', manager);
    expect(r.status).toBe(200);
    expect(r.body.trialBalance.totalDebit).toBe(r.body.trialBalance.totalCredit);
    expect(r.body.incomeStatement).toMatchObject({ totalRevenue: 100_000 + 5_000 - 10_000, totalExpenses: 3_000_000, netIncome: 95_000 - 3_000_000 });
    expect(r.body.incomeStatement.revenue.map((x: { account: string }) => x.account)).toEqual(['4-1000', '4-1100', '4-2000']);
    expect(r.body.trialBalance.rows.find((x: { account: string }) => x.account === '2-1200')).toMatchObject({ balance: 9_500 });
  });

  it('buku besar akun dengan saldo berjalan; akun tak dikenal 404', async () => {
    const r = await h.http('GET', '/v1/outlets/o1/accounting/ledger/1-1100?from=2026-10-02&to=2026-10-02', owner);
    expect(r.body.account).toMatchObject({ code: '1-1100', name: 'Kas' });
    expect(r.body.lines.map((l: { ref: string; debit: number; credit: number; balance: number }) => [l.ref, l.debit, l.credit, l.balance])).toEqual([
      ['JM-1', 0, 3_000_000, -3_000_000], ['JU-POS-o1-20261002', 54_500, 0, -2_945_500],
    ]);
    expect((await h.http('GET', '/v1/outlets/o1/accounting/ledger/9-9999', owner)).status).toBe(404);
  });

  it('membatalkan jurnal manual: alasan wajib, tidak ikut laporan lagi, tetap tercatat; batal dua kali 409', async () => {
    expect((await h.http('POST', '/v1/outlets/o1/accounting/journal/1/void', owner, { reason: '' })).status).toBe(400);
    expect((await h.http('POST', '/v1/outlets/o1/accounting/journal/1/void', manager, { reason: 'salah akun' })).status).toBe(403);
    expect((await h.http('POST', '/v1/outlets/o1/accounting/journal/1/void', owner, { reason: 'salah akun' })).status).toBe(201);
    expect((await h.http('POST', '/v1/outlets/o1/accounting/journal/1/void', owner, { reason: 'salah akun' })).status).toBe(409);
    expect((await h.http('POST', '/v1/outlets/o1/accounting/journal/99/void', owner, { reason: 'tidak ada' })).status).toBe(404);
    const r = await j('?from=2026-10-02&to=2026-10-02');
    expect(r.body.entries.map((x: { ref: string }) => x.ref)).toEqual(['JU-POS-o1-20261002']);
    expect(r.body.manual[0]).toMatchObject({ voided: true, voidReason: 'salah akun' });
    const audit = (await h.db.admin.query<{ action: string }>("select action from audit_log where action like 'journal.%' order by id")).rows.map((a) => a.action);
    expect(audit).toEqual(['journal.create', 'journal.void']);
  });

  it('jurnal manual milik outlet lain atau tenant lain tidak bocor; batal lintas outlet 404', async () => {
    expect((await entry({ date: DAY, memo: 'Biaya cabang B', lines: lines(500_000) }, owner, 'o1b')).status).toBe(201);
    expect((await j('?from=2026-10-02&to=2026-10-02', owner, 'o1')).body.manual.every((m: { memo: string }) => m.memo !== 'Biaya cabang B')).toBe(true);
    expect((await h.http('POST', '/v1/outlets/o1/accounting/journal/2/void', owner, { reason: 'bukan outlet ini' })).status).toBe(404);
    expect((await j('', ownerB, 'o1')).status).toBe(404);
    expect((await entry({ date: DAY, memo: 'Peretasan', lines: lines(1) }, ownerB, 'o1')).status).toBe(404);
    expect((await h.http('GET', '/v1/accounting/accounts', ownerB)).body).toHaveLength(21); // bagan akun terpisah per tenant
  });

  it('bagan akun: tambah akun, nama dan nonaktif; akun sistem tidak boleh dinonaktifkan; akun nonaktif tidak bisa dijurnal', async () => {
    const post = (b: unknown, tok = owner) => h.http('POST', '/v1/accounting/accounts', tok, b);
    expect((await post({ code: '6-5000', name: 'Beban Pemasaran', type: 'EXPENSE' })).status).toBe(201);
    expect((await post({ code: '6-5000', name: 'Dobel', type: 'EXPENSE' })).status).toBe(409);
    expect((await post({ code: '65000', name: 'Salah kode', type: 'EXPENSE' })).status).toBe(400);
    expect((await post({ code: '6-5001', name: 'X', type: 'EXPENSE' })).status).toBe(400);
    expect((await post({ code: '6-5001', name: 'Jenis salah', type: 'LAIN' })).status).toBe(400);
    expect((await post({ code: '6-5002', name: 'Oleh manager', type: 'EXPENSE' }, manager)).status).toBe(403);
    expect((await h.http('PUT', '/v1/accounting/accounts/1-1100', owner, { active: false })).status).toBe(409);
    expect((await h.http('PUT', '/v1/accounting/accounts/6-5000', owner, { name: 'Beban Iklan' })).status).toBe(200);
    expect((await h.http('PUT', '/v1/accounting/accounts/6-5000', owner, { active: false })).status).toBe(200);
    expect((await h.http('PUT', '/v1/accounting/accounts/0-0000', owner, { active: false })).status).toBe(404);
    const r = await entry({ date: DAY, memo: 'Iklan', lines: lines(100, '6-5000') });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('tidak aktif');
  });

  it('ekspor CSV jurnal: BOM, kolom, nama berkas, audit; peran dijaga', async () => {
    const r = await h.raw('/v1/outlets/o1/accounting/export?from=2026-10-02&to=2026-10-02', manager);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="o1-jurnal-2026-10-02_2026-10-02.csv"');
    expect(r.text.charCodeAt(0)).toBe(0xfeff);
    const rows = r.text.slice(1).trim().split('\r\n');
    expect(rows[0]).toBe('Tanggal,No Bukti,Kode Akun,Nama Akun,Debit,Kredit,Memo');
    expect(rows).toContain('2026-10-02,JU-POS-o1-20261002,1-1100,Kas,54500,0,Penjualan POS 2026-10-02');
    expect((await h.raw('/v1/outlets/o1/accounting/export', ops)).status).toBe(403);
    expect((await h.db.admin.query("select 1 from audit_log where action = 'export.journal'")).rowCount).toBe(1);
  });

  it('rentang tidak sah 400', async () => {
    expect((await j('?from=2026-10-05&to=2026-10-02')).status).toBe(400);
    expect((await j('?range=tahun-ini')).status).toBe(400);
  });
});
