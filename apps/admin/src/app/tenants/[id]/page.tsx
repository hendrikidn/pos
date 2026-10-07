import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DailyChart } from '@/components/DailyChart';
import { Shell } from '@/components/Shell';
import { StatTile } from '@/components/StatTile';
import { TenantActions } from '@/components/TenantActions';
import { TenantManager } from '@/components/TenantManager';
import { UserManager } from '@/components/UserManager';
import { api, ApiError, authed, type AdminMe, type TenantDetail } from '@/lib/api';
import { ago, dateWib, num, rupiah, rupiahShort } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function TenantPage({ params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);
  const { me, d } = await authed(async () => {
    const me = await api<AdminMe>('/v1/admin/me');
    try {
      return { me, d: await api<TenantDetail>(`/v1/admin/tenants/${encodeURIComponent(id)}`) };
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) notFound();
      throw e;
    }
  });
  const now = Date.now();
  const k = d.kpi;
  const suspended = d.tenant.suspended_at !== null;
  const offline = k.devicesTotal - k.devicesOnline;
  return (
    <Shell me={me}>
      <Link href="/" className="back">← Semua tenant</Link>
      <h1>{d.tenant.name} {suspended && <span className="status off">Ditangguhkan</span>}</h1>
      <p className="sub"><span className="mono">{d.tenant.id}</span> · dibuat {dateWib(d.tenant.created_at)}</p>
      {suspended && (
        <p className="banner" role="status">
          Tenant ini ditangguhkan sejak {dateWib(d.tenant.suspended_at!)}{d.tenant.suspended_reason ? `: ${d.tenant.suspended_reason}` : ''}.
          Semua token pengguna dan perangkatnya ditolak sampai diaktifkan kembali.
        </p>
      )}

      <div className="tiles">
        <StatTile label="Pesanan, 7 hari" value={num(k.orders7d)} sub={`${num(k.ordersToday)} hari ini · ${num(k.orders30d)} dalam 30 hari`} />
        <StatTile label="Penerimaan, 7 hari" value={rupiahShort(k.revenue7d)} sub={`${rupiahShort(k.revenueToday)} hari ini · ${rupiahShort(k.revenue30d)} dalam 30 hari`} title={rupiah(k.revenue7d)} />
        <StatTile
          label="Perangkat online"
          value={`${num(k.devicesOnline)} / ${num(k.devicesTotal)}`}
          sub={`sensor ${k.sensorsOnline} / ${k.sensorsTotal}${offline > 0 ? ` · ${offline} offline` : ''}`}
          tone={offline > 0 ? 'warn' : undefined}
        />
        <StatTile
          label="Insiden terbuka"
          value={num(k.incidentsOpen)}
          sub={`${num(k.incidentsCritical)} kritis · ${num(k.confirmedFraud30d)} fraud terkonfirmasi (30 hari)`}
          tone={k.incidentsCritical > 0 ? 'bad' : undefined}
        />
        <StatTile label="Staf aktif" value={num(k.staffActive)} sub={`${k.outlets} outlet`} />
        <StatTile label="Aktivitas terakhir" value={k.lastActivityMs === null ? '–' : ago(k.lastActivityMs, now)} sub="perangkat terakhir terlihat" tone={k.lastActivityMs === null ? 'warn' : undefined} />
      </div>

      <DailyChart daily={d.daily} />

      <section className="panel">
        <h2>Outlet</h2>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr><th>Outlet</th><th>Terminal</th><th className="num">Pesanan 7h</th><th className="num">Penerimaan 7h</th><th className="num">Perangkat online</th><th className="num">Insiden</th><th>Terakhir terlihat</th></tr>
            </thead>
            <tbody>
              {d.outletKpis.map((o) => {
                const meta = d.outlets.find((x) => x.id === o.outletId);
                return (
                  <tr key={o.outletId}>
                    <td>{o.outletName}<div className="muted small mono">{o.outletId}</div></td>
                    <td className="mono">{meta?.terminals.join(', ') || '–'}</td>
                    <td className="num">{num(o.orders7d)}</td>
                    <td className="num" title={rupiah(o.revenue7d)}>{rupiahShort(o.revenue7d)}</td>
                    <td className="num">{o.devicesOnline} / {o.devicesTotal}</td>
                    <td className="num nowrap">{o.incidentsOpen}{o.incidentsCritical > 0 && <> · <span className="status off">{o.incidentsCritical} kritis</span></>}</td>
                    <td>{o.lastSeenMs === null ? <span className="muted">belum pernah</span> : ago(o.lastSeenMs, now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted small">Outlet dikelola oleh owner tenant di dashboard-nya (Pengaturan → Outlet).</p>
      </section>

      <UserManager tenantId={d.tenant.id} users={d.users} />
      <TenantManager d={d} now={now} />
      <TenantActions id={d.tenant.id} name={d.tenant.name} suspended={suspended} />
    </Shell>
  );
}
