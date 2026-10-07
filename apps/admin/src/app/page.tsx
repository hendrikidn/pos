import Link from 'next/link';
import { Shell } from '@/components/Shell';
import { StatTile } from '@/components/StatTile';
import { api, authed, type AdminMe, type Overview, type TenantRow } from '@/lib/api';
import { ago, dateWib, num, rupiah, rupiahShort } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function TenantsPage() {
  const [me, o, tenants] = await authed(() => Promise.all([api<AdminMe>('/v1/admin/me'), api<Overview>('/v1/admin/overview'), api<TenantRow[]>('/v1/admin/tenants')]));
  const now = Date.now();
  const active = tenants.filter((t) => !t.suspended_at);
  const suspended = tenants.filter((t) => t.suspended_at);
  return (
    <Shell me={me}>
      <h1>Platform</h1>
      <p className="sub">Ringkasan seluruh tenant. Pesanan dan penerimaan dihitung 7 hari terakhir.</p>

      <div className="tiles">
        <StatTile label="Tenant aktif" value={num(o.tenants.active)} sub={o.tenants.suspended ? `${o.tenants.suspended} ditangguhkan` : 'tidak ada yang ditangguhkan'} />
        <StatTile label="Outlet" value={num(o.outlets)} />
        <StatTile
          label="Perangkat online"
          value={`${num(o.devices.online)} / ${num(o.devices.total)}`}
          sub="terlihat dalam 5 menit terakhir"
          tone={o.devices.total > 0 && o.devices.online < o.devices.total ? 'warn' : undefined}
        />
        <StatTile label="Pesanan, 7 hari" value={num(o.orders7d)} />
        <StatTile label="Penerimaan, 7 hari" value={rupiahShort(o.revenue7d)} sub="bayar dikurangi refund" title={rupiah(o.revenue7d)} />
        <StatTile
          label="Insiden terbuka"
          value={num(o.incidents.open)}
          sub={`${num(o.incidents.critical)} kritis`}
          tone={o.incidents.critical > 0 ? 'bad' : undefined}
        />
        <StatTile label="Tenant tanpa aktivitas" value={num(o.inactive7d)} sub="tidak ada perangkat terlihat 7 hari" tone={o.inactive7d > 0 ? 'warn' : undefined} />
      </div>

      {tenants.length === 0 ? (
        <div className="empty">Belum ada tenant. <Link href="/tenants/new">Buat tenant pertama</Link>.</div>
      ) : (
        <>
          {active.length === 0 ? (
            <div className="empty">Tidak ada tenant aktif. <Link href="/tenants/new">Buat tenant baru</Link>.</div>
          ) : (
            <section className="panel">
              <h2>Tenant aktif</h2>
              <TenantTable rows={active} now={now} />
            </section>
          )}
          {suspended.length > 0 && (
            <details className="panel">
              <summary><strong>Tenant ditangguhkan ({suspended.length})</strong></summary>
              <TenantTable rows={suspended} now={now} />
            </details>
          )}
        </>
      )}
      <p><Link href="/tenants/new" className="btn">Tenant baru</Link></p>
    </Shell>
  );
}

function TenantTable({ rows, now }: { rows: TenantRow[]; now: number }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table">
        <thead>
          <tr>
            <th>Tenant</th><th className="num">Outlet</th><th className="num">Perangkat online</th><th className="num">Pesanan 7h</th>
            <th className="num">Penerimaan 7h</th><th className="num">Insiden</th><th>Aktivitas terakhir</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className={t.suspended_at ? 'off' : ''}>
              <td>
                <Link href={`/tenants/${t.id}`}>{t.name}</Link>{' '}
                {t.suspended_at && <span className="status off">Ditangguhkan</span>}
                <div className="muted small"><span className="mono">{t.id}</span> · dibuat {dateWib(t.created_at)}</div>
              </td>
              <td className="num">{t.kpi.outlets}</td>
              <td className="num">{t.kpi.devicesOnline} / {t.kpi.devicesTotal}</td>
              <td className="num">{num(t.kpi.orders7d)}</td>
              <td className="num" title={rupiah(t.kpi.revenue7d)}>{rupiahShort(t.kpi.revenue7d)}</td>
              <td className="num nowrap">{t.kpi.incidentsOpen}{t.kpi.incidentsCritical > 0 && <> · <span className="status off">{t.kpi.incidentsCritical} kritis</span></>}</td>
              <td>{t.kpi.lastActivityMs === null ? <span className="muted">belum pernah</span> : ago(t.kpi.lastActivityMs, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
