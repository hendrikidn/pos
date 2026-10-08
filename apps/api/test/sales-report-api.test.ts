import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);

describe('GET /v1/outlets/:id/reports/sales', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let manager: string;
  let supervisor: string;
  let other: string;
  let device: string;
  const url = (q = '') => `/v1/outlets/o1/reports/sales${q}`;

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-02T09:00:00'));
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t2', 'o2', 'Outlet 2', { terminals: ['term-2'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    device = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    supervisor = await h.admin.createApiToken('t1', 'hendra', 'SUPERVISOR');
    other = await h.admin.createApiToken('t2', 'owner-2', 'OWNER');

    const s = new Sim('o1', '2026-10-01', 'term-1', 'sensor-1');
    s.cashOrder('a', '10:00:00', '10:05:00', 50_000, 'budi');
    s.cashOrder('b', '11:00:00', '11:05:00', 30_000, 'sari');
    s.pos({ type: 'void.approved', payload: { orderId: 'b', reasonCode: 'CUSTOMER_CANCEL', approverIds: ['hendra'], amount: 30_000 } }, '11:30:00', 'sari');
    // 2026-09-20: order dengan item pesanan, dikirim lewat ingest yang sama seperti terminal sungguhan (rantai yang sama).
    const kopi = { itemId: 'kopi-susu', name: 'Kopi Susu', qty: 2, unitPrice: 22_000 };
    const latte = { itemId: 'latte', name: 'Latte', qty: 1, unitPrice: 26_000 };
    s.pos({ type: 'order.created', payload: { orderId: 'm1', orderType: 'TAKE_AWAY' } }, WIB('2026-09-20T09:00:00'), 'budi');
    s.pos({ type: 'bill.printed', payload: { orderId: 'm1', total: 70_000, items: [kopi, latte] } }, WIB('2026-09-20T09:03:00'), 'budi');
    s.pos({ type: 'payment.received', payload: { orderId: 'm1', method: 'CASH', amount: 70_000 } }, WIB('2026-09-20T09:05:00'), 'budi');
    expect((await h.postEvents(device, s.events)).status).toBe(201);
  });
  afterAll(() => h.close());

  it('rentang bawaan (7 hari sampai hari ini): penjualan order a saja; order b di-void sehingga tidak dihitung', async () => {
    const r = await h.http('GET', url(), owner);
    expect(r.status).toBe(200);
    expect(r.body.range).toMatchObject({ from: '2026-09-26', to: '2026-10-02', days: 7 });
    expect(r.body.totals).toMatchObject({ gross: 50_000, net: 50_000, orders: 1, avgOrder: 50_000 });
    expect(r.body.totals.voids).toEqual({ count: 1, amount: 30_000, afterPayment: { count: 1, amount: 30_000 } });
    expect(r.body.byDay).toHaveLength(7);
    expect(r.body.byDay.find((d: { date: string }) => d.date === '2026-10-01')).toEqual({ date: '2026-10-01', orders: 1, net: 50_000 });
    expect(r.body.byCashier.map((c: { userId: string; voidsAfterPayment: number }) => [c.userId, c.voidsAfterPayment])).toEqual([['budi', 0], ['sari', 1]]);
  });

  it('rentang eksplisit satu hari', async () => {
    const r = await h.http('GET', url('?from=2026-10-01&to=2026-10-01'), owner);
    expect(r.body.range.days).toBe(1);
    expect(r.body.totals.gross).toBe(50_000);
    const empty = await h.http('GET', url('?from=2026-09-30&to=2026-09-30'), owner);
    expect(empty.body.totals).toMatchObject({ gross: 0, orders: 0 });
  });

  it('rincian per produk dibaca dari event yang tersimpan; order tanpa item dilaporkan terpisah', async () => {
    const r = await h.http('GET', url('?from=2026-09-20&to=2026-09-20'), owner);
    expect(r.body.byProduct).toEqual([
      { itemId: 'kopi-susu', name: 'Kopi Susu', qty: 2, amount: 44_000 },
      { itemId: 'latte', name: 'Latte', qty: 1, amount: 26_000 },
    ]);
    expect(r.body.ordersWithoutItems).toBe(0);
    const old = await h.http('GET', url('?from=2026-10-01&to=2026-10-01'), owner);
    expect(old.body.byProduct).toEqual([]);
    expect(old.body.ordersWithoutItems).toBe(1);
  });

  it('OWNER, OPS, dan MANAGER boleh; SUPERVISOR, perangkat, dan tanpa token ditolak', async () => {
    for (const t of [owner, ops, manager]) expect((await h.http('GET', url(), t)).status).toBe(200);
    expect((await h.http('GET', url(), supervisor)).status).toBe(403);
    expect((await h.http('GET', url(), device)).status).toBe(403);
    expect((await h.http('GET', url())).status).toBe(401);
  });

  it('tenant lain tidak bisa membaca outlet ini, dan laporannya sendiri tidak memuat data tenant 1', async () => {
    expect((await h.http('GET', url(), other)).status).toBe(404);
    const mine = await h.http('GET', '/v1/outlets/o2/reports/sales', other);
    expect(mine.status).toBe(200);
    expect(mine.body.totals).toMatchObject({ gross: 0, orders: 0 });
  });

  it('parameter tanggal yang salah ditolak dengan pesan jelas', async () => {
    const bad = async (q: string, re: RegExp) => {
      const r = await h.http('GET', url(q), owner);
      expect(r.status, q).toBe(400);
      expect(r.body.message, q).toMatch(re);
    };
    await bad('?from=2026-10-1', /YYYY-MM-DD/);
    await bad('?from=2026-02-30&to=2026-03-01', /YYYY-MM-DD/);
    await bad('?from=2026-10-05&to=2026-10-01', /tidak boleh setelah/);
    await bad('?to=2026-10-03', /masa depan/);
    await bad('?from=2026-08-01&to=2026-10-02', /maksimal 31 hari/);
  });

  it('preset range dihitung dengan tanggal lokal outlet: today, yesterday, 7d, 30d, month', async () => {
    const get = async (r: string) => (await h.http('GET', url(`?range=${r}`), owner)).body.range;
    expect(await get('today')).toMatchObject({ from: '2026-10-02', to: '2026-10-02', days: 1 });
    expect(await get('yesterday')).toMatchObject({ from: '2026-10-01', to: '2026-10-01', days: 1 });
    expect(await get('7d')).toMatchObject({ from: '2026-09-26', to: '2026-10-02', days: 7 });
    expect(await get('30d')).toMatchObject({ from: '2026-09-03', to: '2026-10-02', days: 30 });
    expect(await get('month')).toMatchObject({ from: '2026-10-01', to: '2026-10-02', days: 2 });
    const y = await h.http('GET', url('?range=yesterday'), owner);
    expect(y.body.totals.gross).toBe(50_000);
  });

  it('range tidak dikenal, atau digabung dengan from/to, ditolak', async () => {
    expect((await h.http('GET', url('?range=year'), owner)).status).toBe(400);
    const both = await h.http('GET', url('?range=7d&from=2026-10-01'), owner);
    expect(both.status).toBe(400);
    expect(both.body.message).toMatch(/tidak keduanya/);
  });

  it('hari "hari ini" mengikuti zona waktu outlet: pukul 23:30 UTC sudah esok hari di WIB', async () => {
    h.setNow(Date.parse('2026-10-02T23:30:00Z')); // 06:30 WIB tanggal 3
    expect((await h.http('GET', url('?range=today'), owner)).body.range).toMatchObject({ from: '2026-10-03', to: '2026-10-03' });
    h.setNow(WIB('2026-10-02T09:00:00'));
  });

  it('31 hari tepat diterima', async () => {
    const r = await h.http('GET', url('?from=2026-09-02&to=2026-10-02'), owner);
    expect(r.status).toBe(200);
    expect(r.body.range.days).toBe(31);
  });

  it('compare=1: periode sebelumnya sama panjang tepat sebelum periode ini; tanpa compare tidak ada comparison', async () => {
    expect((await h.http('GET', url('?range=7d'), owner)).body).not.toHaveProperty('comparison');
    const r = await h.http('GET', url('?from=2026-10-01&to=2026-10-02&compare=1'), owner);
    expect(r.status).toBe(200);
    expect(r.body.comparison.previous.range).toMatchObject({ from: '2026-09-29', to: '2026-09-30', days: 2 });
    expect(r.body.comparison.previous.totals).toMatchObject({ net: 0, orders: 0 });
    expect(r.body.comparison.change.net).toEqual({ delta: 50_000, pct: null });
    expect(r.body.comparison.partial).toBe(true); // memuat hari ini (2026-10-02)
    // periode yang sudah selesai (21 Sep–1 Okt) dibanding 11 hari sebelumnya (10–20 Sep), yang memuat penjualan m1
    const past = await h.http('GET', url('?from=2026-09-21&to=2026-10-01&compare=1'), owner);
    expect(past.body.comparison).toMatchObject({ partial: false, previous: { range: { from: '2026-09-10', to: '2026-09-20', days: 11 } } });
    expect(past.body.comparison.previous.totals).toMatchObject({ net: 70_000, orders: 1 });
    expect(past.body.comparison.change.net).toEqual({ delta: -20_000, pct: -28.6 });
    expect(past.body.comparison.movers.down.map((m: { name: string; delta: number }) => [m.name, m.delta])).toEqual([['Kopi Susu', -44_000], ['Latte', -26_000]]);
    expect(past.body.comparison.previous.byDay).toHaveLength(11);
  });

  it('compare: nilai tidak dikenal 400; peran dan tenant tetap berlaku; tanpa rentang tetap berfungsi', async () => {
    expect((await h.http('GET', url('?compare=semua'), owner)).status).toBe(400);
    expect((await h.http('GET', url('?compare=1'), supervisor)).status).toBe(403);
    expect((await h.http('GET', url('?compare=1'), other)).status).toBeLessThan(500);
    expect((await h.http('GET', url('?compare=1'), other)).status).not.toBe(200);
    expect((await h.http('GET', url('?compare=1'), manager)).body.comparison.previous.range.days).toBe(7);
  });
});
