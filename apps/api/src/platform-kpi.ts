import type { Database } from './db/database';

const DAY_MS = 86_400_000;
/** Perangkat dianggap online bila terlihat dalam 5 menit terakhir (sensor mengirim detak tiap 30 detik). */
export const ONLINE_MS = 5 * 60_000;
export const DAILY_DAYS = 14;

export interface OutletKpi {
  outletId: string;
  outletName: string;
  ordersToday: number;
  orders7d: number;
  orders30d: number;
  revenueToday: number;
  revenue7d: number;
  revenue30d: number;
  devicesTotal: number;
  devicesOnline: number;
  sensorsTotal: number;
  sensorsOnline: number;
  incidentsOpen: number;
  incidentsCritical: number;
  confirmedFraud30d: number;
  lastSeenMs: number | null;
}

export interface TenantKpi {
  outlets: number;
  staffActive: number;
  ordersToday: number;
  orders7d: number;
  orders30d: number;
  /** Penerimaan bersih: pembayaran diterima dikurangi refund. */
  revenueToday: number;
  revenue7d: number;
  revenue30d: number;
  devicesTotal: number;
  devicesOnline: number;
  sensorsTotal: number;
  sensorsOnline: number;
  incidentsOpen: number;
  incidentsCritical: number;
  confirmedFraud30d: number;
  /** Terakhir ada perangkat yang terlihat; null bila belum pernah. */
  lastActivityMs: number | null;
}

export interface DailyPoint {
  /** Tanggal lokal outlet (YYYY-MM-DD). */
  date: string;
  orders: number;
  revenue: number;
}

const num = (v: unknown) => Number(v ?? 0);

/** Penjualan per outlet. Pesanan karyawan (EMPLOYEE) tidak dihitung, dan event berstempel lebih dari sehari di masa depan diabaikan. */
async function salesByOutlet(db: Database, now: number, tenantId?: string) {
  const r = await db.admin.query<Record<string, unknown>>(
    `with ev as (
       select e.tenant_id, e.outlet_id, e.type, e.device_time_ms,
              floor((e.device_time_ms + o.utc_offset_minutes * 60000.0) / 86400000.0) as day,
              floor(($1::float8 + o.utc_offset_minutes * 60000.0) / 86400000.0) as today,
              case e.type when 'payment.received' then (e.payload->>'amount')::float8
                          when 'refund.created' then -(e.payload->>'amount')::float8 else 0 end as money
       from event e join outlet o on o.id = e.outlet_id
       where e.type in ('order.created', 'payment.received', 'refund.created')
         and e.device_time_ms >= $2::float8 and e.device_time_ms <= $1::float8 + 86400000
         and ($3::text is null or e.tenant_id = $3)
         and not (e.type = 'order.created' and coalesce(e.payload->>'orderType', '') = 'EMPLOYEE')
     )
     select tenant_id, outlet_id,
            count(*) filter (where type = 'order.created' and day = today)::int as orders_today,
            count(*) filter (where type = 'order.created' and device_time_ms >= $4::float8)::int as orders_7d,
            count(*) filter (where type = 'order.created')::int as orders_30d,
            coalesce(sum(money) filter (where day = today), 0)::float8 as revenue_today,
            coalesce(sum(money) filter (where device_time_ms >= $4::float8), 0)::float8 as revenue_7d,
            coalesce(sum(money), 0)::float8 as revenue_30d
     from ev group by tenant_id, outlet_id`,
    [now, now - 30 * DAY_MS, tenantId ?? null, now - 7 * DAY_MS],
  );
  return r.rows;
}

/**
 * KPI semua tenant (atau satu tenant) dihitung sebagai pemilik skema, melewati RLS: hanya dipanggil dari endpoint admin platform.
 * Mengembalikan KPI per outlet dan ringkasannya per tenant.
 */
export async function computeKpis(db: Database, now: number, tenantId?: string) {
  const t = tenantId ?? null;
  const [outlets, sales, devices, incidents, staff] = await Promise.all([
    db.admin.query<{ id: string; tenant_id: string; name: string }>('select id, tenant_id, name from outlet where ($1::text is null or tenant_id = $1) order by name', [t]),
    salesByOutlet(db, now, tenantId),
    db.admin.query<Record<string, unknown>>(
      `select tenant_id, outlet_id, count(*)::int as total,
              count(*) filter (where last_seen_ms >= $1::float8 - $3::float8)::int as online,
              count(*) filter (where kind = 'sensor')::int as sensors_total,
              count(*) filter (where kind = 'sensor' and last_seen_ms >= $1::float8 - $3::float8)::int as sensors_online,
              max(last_seen_ms) as last_seen
       from device where revoked_at is null and ($2::text is null or tenant_id = $2) group by tenant_id, outlet_id`,
      [now, t, ONLINE_MS],
    ),
    db.admin.query<Record<string, unknown>>(
      `select tenant_id, outlet_id,
              count(*) filter (where status = 'OPEN' and not shadow)::int as open,
              count(*) filter (where status = 'OPEN' and level = 'CRITICAL' and not shadow)::int as critical,
              count(*) filter (where status = 'CONFIRMED_FRAUD' and not shadow and start_ms >= $1::float8)::int as confirmed
       from incident where ($2::text is null or tenant_id = $2) group by tenant_id, outlet_id`,
      [now - 30 * DAY_MS, t],
    ),
    db.admin.query<{ tenant_id: string; n: number }>('select tenant_id, count(*)::int as n from staff where active and ($1::text is null or tenant_id = $1) group by tenant_id', [t]),
  ]);

  const by = (rows: Record<string, unknown>[]) => new Map(rows.map((r) => [String(r['outlet_id']), r]));
  const salesM = by(sales);
  const devM = by(devices.rows);
  const incM = by(incidents.rows);

  const byOutlet = new Map<string, OutletKpi[]>();
  for (const o of outlets.rows) {
    const s = salesM.get(o.id), d = devM.get(o.id), i = incM.get(o.id);
    const k: OutletKpi = {
      outletId: o.id, outletName: o.name,
      ordersToday: num(s?.['orders_today']), orders7d: num(s?.['orders_7d']), orders30d: num(s?.['orders_30d']),
      revenueToday: num(s?.['revenue_today']), revenue7d: num(s?.['revenue_7d']), revenue30d: num(s?.['revenue_30d']),
      devicesTotal: num(d?.['total']), devicesOnline: num(d?.['online']), sensorsTotal: num(d?.['sensors_total']), sensorsOnline: num(d?.['sensors_online']),
      incidentsOpen: num(i?.['open']), incidentsCritical: num(i?.['critical']), confirmedFraud30d: num(i?.['confirmed']),
      lastSeenMs: d?.['last_seen'] === null || d?.['last_seen'] === undefined ? null : num(d['last_seen']),
    };
    byOutlet.set(o.tenant_id, [...(byOutlet.get(o.tenant_id) ?? []), k]);
  }

  const staffM = new Map(staff.rows.map((r) => [r.tenant_id, r.n]));
  const tenants = new Map<string, TenantKpi>();
  for (const [tid, list] of byOutlet) {
    const sum = (f: (o: OutletKpi) => number) => list.reduce((a, o) => a + f(o), 0);
    const seen = list.map((o) => o.lastSeenMs).filter((v): v is number => v !== null);
    tenants.set(tid, {
      outlets: list.length, staffActive: staffM.get(tid) ?? 0,
      ordersToday: sum((o) => o.ordersToday), orders7d: sum((o) => o.orders7d), orders30d: sum((o) => o.orders30d),
      revenueToday: sum((o) => o.revenueToday), revenue7d: sum((o) => o.revenue7d), revenue30d: sum((o) => o.revenue30d),
      devicesTotal: sum((o) => o.devicesTotal), devicesOnline: sum((o) => o.devicesOnline),
      sensorsTotal: sum((o) => o.sensorsTotal), sensorsOnline: sum((o) => o.sensorsOnline),
      incidentsOpen: sum((o) => o.incidentsOpen), incidentsCritical: sum((o) => o.incidentsCritical), confirmedFraud30d: sum((o) => o.confirmedFraud30d),
      lastActivityMs: seen.length ? Math.max(...seen) : null,
    });
  }
  return { byOutlet, tenants };
}

/** KPI kosong untuk tenant tanpa outlet. */
export const emptyKpi = (): TenantKpi => ({
  outlets: 0, staffActive: 0, ordersToday: 0, orders7d: 0, orders30d: 0, revenueToday: 0, revenue7d: 0, revenue30d: 0,
  devicesTotal: 0, devicesOnline: 0, sensorsTotal: 0, sensorsOnline: 0, incidentsOpen: 0, incidentsCritical: 0, confirmedFraud30d: 0, lastActivityMs: null,
});

/** Pesanan dan penerimaan per hari selama 14 hari terakhir (terisi nol), memakai zona waktu outlet. */
export async function dailySeries(db: Database, now: number, tenantId: string): Promise<DailyPoint[]> {
  const off = (await db.admin.query<{ m: number | null }>('select max(utc_offset_minutes)::int as m from outlet where tenant_id = $1', [tenantId])).rows[0]?.m ?? 420;
  const todayIdx = Math.floor((now + off * 60_000) / DAY_MS);
  const rows = (
    await db.admin.query<{ day: string; orders: number; revenue: number }>(
      `select floor((e.device_time_ms + o.utc_offset_minutes * 60000.0) / 86400000.0)::bigint as day,
              count(*) filter (where e.type = 'order.created')::int as orders,
              coalesce(sum(case e.type when 'payment.received' then (e.payload->>'amount')::float8
                                       when 'refund.created' then -(e.payload->>'amount')::float8 else 0 end), 0)::float8 as revenue
       from event e join outlet o on o.id = e.outlet_id
       where e.tenant_id = $1 and e.type in ('order.created', 'payment.received', 'refund.created')
         and e.device_time_ms >= $2::float8 and e.device_time_ms <= $3::float8
         and not (e.type = 'order.created' and coalesce(e.payload->>'orderType', '') = 'EMPLOYEE')
       group by 1`,
      [tenantId, now - (DAILY_DAYS + 2) * DAY_MS, now + DAY_MS],
    )
  ).rows;
  const m = new Map(rows.map((r) => [Number(r.day), r]));
  const out: DailyPoint[] = [];
  for (let i = DAILY_DAYS - 1; i >= 0; i--) {
    const idx = todayIdx - i;
    const r = m.get(idx);
    out.push({ date: new Date(idx * DAY_MS).toISOString().slice(0, 10), orders: num(r?.orders), revenue: num(r?.revenue) });
  }
  return out;
}
