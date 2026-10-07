import Link from 'next/link';
import { Shell } from '@/components/Shell';
import { api, authed, type AdminMe, type TenantRow } from '@/lib/api';
import { ago, dateWib } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function TenantsPage() {
  const [me, tenants] = await authed(() => Promise.all([api<AdminMe>('/v1/admin/me'), api<TenantRow[]>('/v1/admin/tenants')]));
  const now = Date.now();
  return (
    <Shell me={me}>
      <h1>Tenant</h1>
      <p className="sub">{tenants.length} tenant terdaftar di platform.</p>
      {tenants.length === 0 ? (
        <div className="empty">Belum ada tenant. <Link href="/tenants/new">Buat tenant pertama</Link>.</div>
      ) : (
        <section className="panel">
          <table className="table">
            <thead><tr><th>Tenant</th><th className="num">Outlet</th><th className="num">Perangkat</th><th className="num">Token owner</th><th>Aktivitas terakhir</th><th>Dibuat</th></tr></thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td><Link href={`/tenants/${t.id}`}>{t.name}</Link><div className="muted small mono">{t.id}</div></td>
                  <td className="num">{t.outlets}</td>
                  <td className="num">{t.devices}</td>
                  <td className="num">{t.owner_tokens}</td>
                  <td>{t.last_seen_ms === null ? '–' : ago(t.last_seen_ms, now)}</td>
                  <td>{dateWib(t.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <p><Link href="/tenants/new" className="btn">Tenant baru</Link></p>
    </Shell>
  );
}
