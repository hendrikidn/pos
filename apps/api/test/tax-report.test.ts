import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { buildTaxReport, taxReportCsv } from '../src/tax-report';
import { DAY_MS, startOfLocalDay } from '../src/sales-report';
import { createHarness, type Harness } from './harness';

const D1 = '2026-09-01';
const NOW = Date.parse('2026-10-03T09:00:00+07:00');
const at = (day: string, hms: string) => Date.parse(`${day}T${hms}+07:00`);
const OUTLET = { name: 'Kopi Senopati', taxPercent: 10, servicePercent: 5, taxOnService: true };

/**
 * Angka yang bisa dihitung manual (PBJT 10%, service 5% ikut dikenai pajak):
 *  a  dine-in    subtotal 100.000, diskon 10.000, service 4.500, pajak 9.450, bulat 50 -> total 104.000   (tunai)
 *  b  take-away  subtotal  50.000, tanpa diskon, service 2.500, pajak 5.250, bulat -250  -> total  57.500 (QRIS) ; refund 11.500 (20%)
 *  c  online     subtotal  40.000, service 0, pajak 0 (platform)                         -> total  40.000 (PLATFORM)
 *  v  di-void (tidak dihitung), e  makan karyawan (tidak dihitung), l  event lama tanpa rincian (dihitung order & total, pajak tidak)
 */
function sample(): Sim {
  const s = new Sim('o1', D1, 'term-1', 'sensor-1');
  const bill = (id: string, total: number, bd?: { subtotal: number; discount: number; service: number; tax: number; rounding: number }, t = '10:04:00', d = D1) =>
    s.pos({ type: 'bill.printed', payload: { orderId: id, total, ...(bd ? { breakdown: bd } : {}) } }, at(d, t), 'budi');
  const pay = (id: string, method: 'CASH' | 'QRIS' | 'PLATFORM', amount: number, t: string, d = D1) =>
    s.pos({ type: 'payment.received', payload: { orderId: id, method, amount, ...(method === 'QRIS' ? { tid: '12345678' } : {}) } }, at(d, t), 'budi');
  const create = (id: string, type: 'DINE_IN' | 'TAKE_AWAY' | 'EMPLOYEE', t: string, d = D1) =>
    s.pos({ type: 'order.created', payload: { orderId: id, orderType: type, ...(type === 'EMPLOYEE' ? { employeeId: 'andi' } : {}) } } as never, at(d, t), 'budi');
  create('a', 'DINE_IN', '10:00:00');
  bill('a', 104_000, { subtotal: 100_000, discount: 10_000, service: 4_500, tax: 9_450, rounding: 50 });
  pay('a', 'CASH', 104_000, '10:05:00');
  create('b', 'TAKE_AWAY', '11:00:00', '2026-09-02');
  bill('b', 57_500, { subtotal: 50_000, discount: 0, service: 2_500, tax: 5_250, rounding: -250 }, '11:01:00', '2026-09-02');
  pay('b', 'QRIS', 57_500, '11:02:00', '2026-09-02');
  s.pos({ type: 'refund.created', payload: { refundId: 'b-R1', originalOrderId: 'b', amount: 11_500, method: 'CASH', approverId: 'hendra' } }, at('2026-09-02', '11:30:00'), 'budi');
  s.pos({ type: 'order.created', payload: { orderId: 'c', orderType: 'TAKE_AWAY' } }, at('2026-09-02', '12:00:00'), 'budi');
  s.pos({ type: 'order.channel_linked', payload: { orderId: 'c', channel: 'GOFOOD', ref: 'GF-1001' } }, at('2026-09-02', '12:00:01'), 'budi');
  bill('c', 40_000, { subtotal: 40_000, discount: 0, service: 0, tax: 0, rounding: 0 }, '12:01:00', '2026-09-02');
  pay('c', 'PLATFORM', 40_000, '12:02:00', '2026-09-02');
  create('v', 'TAKE_AWAY', '13:00:00', '2026-09-02');
  bill('v', 30_000, { subtotal: 27_273, discount: 0, service: 0, tax: 2_727, rounding: 0 }, '13:01:00', '2026-09-02');
  pay('v', 'CASH', 30_000, '13:02:00', '2026-09-02');
  s.pos({ type: 'void.approved', payload: { orderId: 'v', reasonCode: 'WRONG_ORDER', approverIds: ['hendra'], amount: 30_000 } }, at('2026-09-02', '13:05:00'), 'budi');
  create('e', 'EMPLOYEE', '14:00:00', '2026-09-02');
  pay('e', 'CASH', 10_000, '14:01:00', '2026-09-02');
  create('l', 'TAKE_AWAY', '15:00:00', '2026-09-03');
  bill('l', 20_000, undefined, '15:01:00', '2026-09-03');
  pay('l', 'CASH', 20_000, '15:02:00', '2026-09-03');
  return s;
}

const run = (s: Sim, from = '2026-09-01', to = '2026-09-30') =>
  buildTaxReport({ events: s.events, from, to, utcOffsetMinutes: 420, now: NOW, fromMs: startOfLocalDay(from, 420), toMs: startOfLocalDay(to, 420) + DAY_MS }, OUTLET, '2026-09');

describe('laporan pajak bulanan (murni)', () => {
  const r = run(sample());

  it('total sesuai hitungan manual: order terhitung, void dan makan karyawan tidak', () => {
    expect(r.totals.orders).toBe(4); // a, b, c, l
    expect(r.totals.subtotal).toBe(190_000);
    expect(r.totals.discount).toBe(10_000);
    expect(r.totals.service).toBe(7_000);
    expect(r.totals.tax).toBe(14_700);
    expect(r.totals.rounding).toBe(-200);
    expect(r.totals.total).toBe(104_000 + 57_500 + 40_000 + 20_000);
    // dasar pajak a: 100.000 - 10.000 + 4.500 = 94.500 -> pajak 9.450 (10%); b: 52.500 -> 5.250; c: 40.000
    expect(r.totals.taxBase).toBe(94_500 + 52_500 + 40_000);
    expect(r.totals.taxBase * 0.1).toBeCloseTo(r.totals.tax + 4_000, 0); // c tanpa pajak (platform) sehingga selisihnya persis 4.000
    expect(r.totals.omzet).toBe(190_000 - 10_000 + 7_000);
  });

  it('per hari: tanggal order mengikuti pembayaran pertama; hari kosong tetap ada', () => {
    expect(r.byDay).toHaveLength(30);
    expect(r.byDay.find((d) => d.date === '2026-09-01')).toMatchObject({ orders: 1, subtotal: 100_000, tax: 9_450, total: 104_000 });
    expect(r.byDay.find((d) => d.date === '2026-09-02')).toMatchObject({ orders: 2, subtotal: 90_000, tax: 5_250, rounding: -250, total: 97_500 });
    expect(r.byDay.find((d) => d.date === '2026-09-03')).toMatchObject({ orders: 1, subtotal: 0, tax: 0, total: 20_000 });
    expect(r.byDay.find((d) => d.date === '2026-09-15')).toMatchObject({ orders: 0, tax: 0, total: 0 });
    expect(r.byDay.reduce((s, d) => s + d.tax, 0)).toBe(r.totals.tax);
  });

  it('platform dipisah; refund dan perkiraan pajaknya sebanding; order tanpa rincian ditandai', () => {
    expect(r.totals.platform).toEqual({ orders: 1, total: 40_000 });
    expect(r.totals.refunds).toEqual({ count: 1, amount: 11_500, taxEstimate: 1_050 }); // 11.500/57.500 = 20% x 5.250
    expect(r.totals.netTax).toBe(14_700 - 1_050);
    expect(r.withoutBreakdown).toBe(1);
    expect(r.notes.join(' ')).toContain('bukan nasihat pajak');
  });

  it('CSV: BOM, judul memuat tarif, baris per hari plus TOTAL', () => {
    const csv = taxReportCsv(r);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('Tanggal,Order,Subtotal,Diskon,Service,Dasar pengenaan pajak,PBJT 10%,Pembulatan,Total tagihan');
    expect(lines).toHaveLength(1 + 30 + 1);
    expect(lines.at(-1)).toBe('TOTAL,4,190000,10000,7000,187000,14700,-200,221500');
  });

  it('service tidak ikut dasar pajak bila outlet mengaturnya begitu', () => {
    const s = sample();
    const x = buildTaxReport({ events: s.events, from: '2026-09-01', to: '2026-09-30', utcOffsetMinutes: 420, now: NOW, fromMs: startOfLocalDay('2026-09-01', 420), toMs: startOfLocalDay('2026-09-30', 420) + DAY_MS }, { ...OUTLET, taxOnService: false }, '2026-09');
    expect(x.totals.taxBase).toBe(r.totals.taxBase - 7_000);
  });
});

describe('laporan pajak lewat API', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let rina: string;
  let ownerB: string;
  let term: string;
  let kds: string;

  beforeAll(async () => {
    h = await createHarness(NOW);
    await h.admin.createTenant('t1', 'T1');
    await h.admin.createTenant('t2', 'T2');
    await h.admin.createOutlet('t1', 'o1', 'Kopi Satu', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t2', 'ox', 'X');
    await h.db.admin.query("update outlet set tax_percent = 10, service_charge_percent = 5, tax_on_service = true where id = 'o1'");
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    rina = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    kds = await h.admin.createDevice('t1', 'o1', 'kds-1', 'kds');
    const s = sample();
    expect((await h.postEvents(term, s.events)).status).toBe(201);
  });
  afterAll(() => h.close());

  it('hanya OWNER, OPS, MANAGER; perangkat dan tenant lain ditolak; bulan harus YYYY-MM dan tidak di masa depan', async () => {
    const get = (p: string, tok?: string) => h.http('GET', `/v1/outlets/o1/reports/tax${p}`, tok);
    expect((await get('?month=2026-09')).status).toBe(401);
    expect((await get('?month=2026-09', term)).status).toBe(403);
    expect((await get('?month=2026-09', kds)).status).toBe(403);
    expect((await h.http('GET', '/v1/outlets/o1/reports/tax?month=2026-09', ownerB)).status).toBeGreaterThanOrEqual(400);
    for (const bad of ['', '?month=2026-9', '?month=2026-13', '?month=abc', '?month=2026-09-01', '?month=2027-01']) expect((await get(bad, owner)).status).toBe(400);
    for (const tok of [owner, ops, rina]) expect((await get('?month=2026-09', tok)).status).toBe(200);
  });

  it('JSON memuat angka yang sama dengan hitungan manual dan CSV bisa diunduh; setiap ekspor tercatat di audit', async () => {
    const r = (await h.http('GET', '/v1/outlets/o1/reports/tax?month=2026-09', owner)).body;
    expect(r.outlet).toMatchObject({ taxPercent: 10, servicePercent: 5, taxOnService: true });
    expect(r.period).toEqual({ month: '2026-09', from: '2026-09-01', to: '2026-09-30' });
    expect(r.totals).toMatchObject({ orders: 4, tax: 14_700, total: 221_500 });
    const csv = await h.raw('/v1/outlets/o1/reports/tax?month=2026-09&format=csv', owner);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toContain('o1-pajak-2026-09.csv');
    expect(csv.text).toContain('TOTAL,4,190000');
    expect(Number((await h.db.admin.query<{ n: string }>("select count(*) n from audit_log where action = 'export.tax'")).rows[0]!.n)).toBeGreaterThanOrEqual(2);
  });

  it('bulan berjalan dipotong sampai hari ini; bulan tanpa transaksi menghasilkan nol, bukan kesalahan', async () => {
    const cur = (await h.http('GET', '/v1/outlets/o1/reports/tax?month=2026-10', owner)).body;
    expect(cur.period).toEqual({ month: '2026-10', from: '2026-10-01', to: '2026-10-03' });
    expect(cur.totals.orders).toBe(0);
    const old = (await h.http('GET', '/v1/outlets/o1/reports/tax?month=2026-02', owner)).body;
    expect(old.byDay).toHaveLength(28);
    expect(old.totals.tax).toBe(0);
  });
});
