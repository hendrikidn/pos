import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformAdmin } from '../src/onboard';
import { createHarness, type Harness } from './harness';

const NOW = Date.parse('2026-10-07T10:00:00+07:00');
const DAY = 86_400_000;
const HOUR = 3_600_000;

describe('KPI tenant di konsol admin', () => {
  let h: Harness;
  let admin: string;
  let seq = 0;

  /** Menyisipkan event langsung: yang diuji adalah perhitungan KPI, bukan jalur ingest. */
  const ev = (tenant: string, outlet: string, device: string, type: string, at: number, payload: object) =>
    h.db.admin.query(
      `insert into event (id, tenant_id, outlet_id, device_id, seq, type, device_time_ms, prev_hash, hash, payload)
       values ($1, $2, $3, $4, $5, $6, $7, repeat('0', 64), repeat('1', 64), $8::jsonb)`,
      [`e${++seq}`, tenant, outlet, device, seq, type, at, JSON.stringify(payload)],
    );
  const order = (id: string, at: number, orderType = 'DINE_IN') => ev('kopi', 'kopi-pusat', 'pos-1', 'order.created', at, { orderId: id, orderType });
  const pay = (id: string, at: number, amount: number) => ev('kopi', 'kopi-pusat', 'pos-1', 'payment.received', at, { orderId: id, method: 'CASH', amount });
  const refund = (id: string, at: number, amount: number) => ev('kopi', 'kopi-pusat', 'pos-1', 'refund.created', at, { refundId: `r-${id}`, originalOrderId: id, amount, method: 'CASH', approverId: 'a' });
  const voidIt = (id: string, at: number, amount: number) => ev('kopi', 'kopi-pusat', 'pos-1', 'void.approved', at, { orderId: id, reasonCode: 'CUSTOMER_CANCEL', approverIds: ['hendra'], amount });
  /** Order lengkap: dibuat lalu dibayar satu detik kemudian. */
  const sale = async (id: string, at: number, amount: number, orderType = 'DINE_IN') => { await order(id, at, orderType); await pay(id, at + 1000, amount); };

  beforeAll(async () => {
    h = await createHarness(NOW);
    admin = (await createPlatformAdmin(h.db, { id: 'adm', name: 'Adm' })).token;
    const mk = (b: object) => h.http('POST', '/v1/admin/tenants', admin, b);
    expect((await mk({ tenantId: 'kopi', tenantName: 'Kopi', outletId: 'kopi-pusat', outletName: 'Pusat', terminals: ['pos-1'] })).status).toBe(201);
    expect((await mk({ tenantId: 'sepi', tenantName: 'Sepi', outletId: 'sepi-o', outletName: 'Sepi O' })).status).toBe(201);
    await h.admin.createOutlet('kopi', 'kopi-cabang', 'Cabang');

    // Perangkat: sensor online (60 dtk lalu), terminal offline (10 mnt lalu), satu sensor dicabut (tidak dihitung).
    const sensor = await h.admin.createDevice('kopi', 'kopi-pusat', 'sensor-1', 'sensor');
    await h.admin.createDevice('kopi', 'kopi-pusat', 'pos-1', 'terminal');
    await h.admin.createDevice('kopi', 'kopi-pusat', 'sensor-lama', 'sensor');
    void sensor;
    await h.db.admin.query("update device set last_seen_ms = $1 where id = 'sensor-1'", [NOW - 60_000]);
    await h.db.admin.query("update device set last_seen_ms = $1 where id = 'pos-1'", [NOW - 10 * 60_000]);
    await h.db.admin.query("update device set revoked_at = now(), last_seen_ms = $1 where id = 'sensor-lama'", [NOW - 1000]);

    // Hari ini (WIB): A 50.000 dan B 30.000, refund A 10.000 -> 70.000, 2 pesanan.
    // Tidak dihitung: E (makan karyawan) dan V (dibayar 40.000 lalu di-void, beserta refund 5.000 atas V).
    await sale('A', NOW - 2 * HOUR, 50_000); await sale('B', NOW - HOUR, 30_000); await refund('A', NOW - 30 * 60_000, 10_000);
    await sale('E', NOW - HOUR, 15_000, 'EMPLOYEE');
    await sale('V', NOW - 90 * 60_000, 40_000); await voidIt('V', NOW - 80 * 60_000, 40_000); await refund('V', NOW - 70 * 60_000, 5_000);
    // 3 hari lalu: masuk 7 hari. 20 hari lalu: hanya 30 hari. 40 hari lalu dan 3 hari ke depan: diabaikan.
    await sale('C', NOW - 3 * DAY, 20_000);
    await sale('D', NOW - 20 * DAY, 100_000);
    await sale('F', NOW - 40 * DAY, 999_000);
    await sale('G', NOW + 3 * DAY, 888_000);

    // Insiden: satu kritis terbuka, satu rendah terbuka, satu fraud terkonfirmasi (30 hari), satu sah.
    const inc = (id: string, level: string, status: string, start: number) =>
      h.db.admin.query(
        `insert into incident (id, tenant_id, outlet_id, start_ms, end_ms, score, level, multiplier, order_ids, actor_ids, hits, status)
         values ($1, 'kopi', 'kopi-pusat', $2, $2, 50, $3, 1, '[]', '[]', '[]', $4)`,
        [id, start, level, status],
      );
    await inc('i1', 'CRITICAL', 'OPEN', NOW - HOUR);
    await inc('i2', 'LOW', 'OPEN', NOW - 2 * HOUR);
    await inc('i3', 'CRITICAL', 'CONFIRMED_FRAUD', NOW - 5 * DAY);
    await inc('i4', 'MEDIUM', 'LEGIT', NOW - 5 * DAY);

    const owner = (await h.http('POST', '/v1/admin/tenants/kopi/owner-tokens', admin, {})).body.ownerToken;
    await h.http('POST', '/v1/staff', owner, { id: 'rudi', name: 'Rudi', role: 'CASHIER', pin: '4827' });
    await h.http('POST', '/v1/staff', owner, { id: 'sri', name: 'Sri', role: 'CASHIER', pin: '7351' });
    await h.http('PUT', '/v1/staff/sri', owner, { active: false });
  });
  afterAll(() => h.close());

  it('KPI tenant: pesanan, penerimaan bersih, perangkat, insiden, dan staf dihitung benar', async () => {
    const d = (await h.http('GET', '/v1/admin/tenants/kopi', admin)).body;
    expect(d.kpi).toMatchObject({
      outlets: 2,
      staffActive: 1,
      ordersToday: 2, orders7d: 3, orders30d: 4, // karyawan, order di-void, 40 hari lalu, dan masa depan tidak dihitung
      revenueToday: 70_000, revenue7d: 90_000, revenue30d: 190_000, // bayar dikurangi refund; void dan karyawan tidak masuk
      devicesTotal: 2, devicesOnline: 1, sensorsTotal: 1, sensorsOnline: 1, // perangkat dicabut tidak dihitung
      incidentsOpen: 2, incidentsCritical: 1, confirmedFraud30d: 1,
      lastActivityMs: NOW - 60_000,
    });
  });

  it('KPI per outlet: outlet tanpa data tetap muncul dengan nol', async () => {
    const o = (await h.http('GET', '/v1/admin/tenants/kopi', admin)).body.outletKpis;
    expect(o.map((x: { outletId: string }) => x.outletId).sort()).toEqual(['kopi-cabang', 'kopi-pusat']);
    expect(o.find((x: { outletId: string }) => x.outletId === 'kopi-pusat')).toMatchObject({ orders7d: 3, revenue7d: 90_000, devicesOnline: 1, incidentsCritical: 1 });
    expect(o.find((x: { outletId: string }) => x.outletId === 'kopi-cabang')).toMatchObject({ orders7d: 0, revenue7d: 0, devicesTotal: 0, lastSeenMs: null });
  });

  it('deret harian 14 hari terisi nol, berurutan, dan hari ini memakai zona waktu outlet', async () => {
    const daily = (await h.http('GET', '/v1/admin/tenants/kopi', admin)).body.daily;
    expect(daily).toHaveLength(14);
    expect(daily.map((p: { date: string }) => p.date)).toEqual([...daily.map((p: { date: string }) => p.date)].sort());
    expect(daily.at(-1)).toEqual({ date: '2026-10-07', orders: 2, revenue: 70_000 });
    expect(daily.at(-4)).toEqual({ date: '2026-10-04', orders: 1, revenue: 20_000 });
    expect(daily.at(-2)).toEqual({ date: '2026-10-06', orders: 0, revenue: 0 });
    // 20 hari lalu berada di luar 14 hari terakhir.
    expect(daily.reduce((a: number, p: { orders: number }) => a + p.orders, 0)).toBe(3);
  });

  it('batas hari mengikuti zona waktu outlet: 00:30 WIB masuk hari ini, 23:30 WIB sebelumnya masuk kemarin', async () => {
    h.setNow(Date.parse('2026-10-07T00:45:00+07:00'));
    try {
      await sale('b1', Date.parse('2026-10-07T00:30:00+07:00'), 1_000);
      await sale('b2', Date.parse('2026-10-06T23:30:00+07:00'), 1_000);
      const d = (await h.http('GET', '/v1/admin/tenants/kopi', admin)).body;
      // Hari ini (7 Okt WIB) = A dan B (pukul 08:00 dan 09:00, hari kalender yang sama) + b1. b2 jatuh pada 6 Okt.
      expect(d.kpi.ordersToday).toBe(3);
      expect(d.daily.at(-1)).toMatchObject({ date: '2026-10-07', orders: 3 });
      expect(d.daily.at(-2)).toMatchObject({ date: '2026-10-06', orders: 1 });
    } finally {
      h.setNow(NOW);
    }
  });

  it('KONSISTENSI: angka KPI konsol admin sama persis dengan laporan penjualan owner untuk rentang yang sama', async () => {
    const owner = await h.admin.createApiToken('kopi', 'owner-konsistensi', 'OWNER');
    const kpi = (await h.http('GET', '/v1/admin/tenants/kopi', admin)).body.outletKpis.find((x: { outletId: string }) => x.outletId === 'kopi-pusat');
    for (const [range, orders, revenue] of [['today', 'ordersToday', 'revenueToday'], ['7d', 'orders7d', 'revenue7d'], ['30d', 'orders30d', 'revenue30d']] as const) {
      const r = await h.http('GET', `/v1/outlets/kopi-pusat/reports/sales?range=${range}`, owner);
      expect(r.status, range).toBe(200);
      expect(r.body.totals.orders, `pesanan ${range}`).toBe(kpi[orders]);
      expect(r.body.totals.net, `penerimaan ${range}`).toBe(kpi[revenue]);
    }
  });

  it('pembayaran sebagian dan terpisah: satu order dihitung sekali (+1), penerimaan menjumlahkan semua pembayarannya (+25.000), sama dengan laporan owner', async () => {
    const owner = await h.admin.createApiToken('kopi', 'owner-konsistensi-2', 'OWNER');
    const read = async () => ({
      kpi: (await h.http('GET', '/v1/admin/tenants/kopi', admin)).body.kpi,
      report: (await h.http('GET', '/v1/outlets/kopi-pusat/reports/sales?range=today', owner)).body.totals,
    });
    const before = await read();
    await order('S', NOW - 30 * 60_000);
    await pay('S', NOW - 29 * 60_000, 10_000);
    await pay('S', NOW - 28 * 60_000, 15_000);
    const after = await read();
    expect(after.kpi.ordersToday - before.kpi.ordersToday).toBe(1);
    expect(after.kpi.revenueToday - before.kpi.revenueToday).toBe(25_000);
    expect(after.report.orders).toBe(after.kpi.ordersToday);
    expect(after.report.net).toBe(after.kpi.revenueToday);
  });

  it('daftar tenant dan ringkasan platform menjumlahkan KPI semua tenant', async () => {
    const list = (await h.http('GET', '/v1/admin/tenants', admin)).body;
    expect(list.find((t: { id: string }) => t.id === 'kopi').kpi.orders7d).toBeGreaterThanOrEqual(3);
    expect(list.find((t: { id: string }) => t.id === 'sepi').kpi).toMatchObject({ orders7d: 0, devicesTotal: 0, lastActivityMs: null });

    const o = (await h.http('GET', '/v1/admin/overview', admin)).body;
    expect(o.tenants).toEqual({ total: 2, active: 2, suspended: 0 });
    expect(o.outlets).toBe(3);
    expect(o.devices).toEqual({ total: 2, online: 1 });
    expect(o.incidents).toEqual({ open: 2, critical: 1 });
    // "sepi" tidak punya aktivitas sama sekali; "kopi" aktif.
    expect(o.inactive7d).toBe(1);
  });

  it('endpoint KPI hanya untuk admin platform', async () => {
    const owner = (await h.http('POST', '/v1/admin/tenants/kopi/owner-tokens', admin, {})).body.ownerToken;
    expect((await h.http('GET', '/v1/admin/overview', owner)).status).toBe(403);
    expect((await h.http('GET', '/v1/admin/overview')).status).toBe(401);
  });
});
