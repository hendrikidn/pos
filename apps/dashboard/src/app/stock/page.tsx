import Link from 'next/link';
import { Shell } from '@/components/Shell';
import { StockBoard } from '@/components/StockBoard';
import { PaperPanel } from '@/components/PaperPanel';
import { api, authed, type CountRow, type Me, type Outlet, type PaperRolls, type StockRow } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function StockPage({ searchParams }: { searchParams: Promise<{ outlet?: string }> }) {
  const sp = await searchParams;
  const { me, outlets } = await authed(async () => ({ me: await api<Me>('/v1/me'), outlets: await api<Outlet[]>('/v1/outlets') }));
  if (me.role !== 'OWNER' && me.role !== 'OPS' && me.role !== 'MANAGER') {
    return <Shell me={me}><div className="empty">Stok hanya untuk owner, ops, dan manager.</div></Shell>;
  }
  const outlet = outlets.find((o) => o.id === sp.outlet) ?? outlets[0];
  if (!outlet) return <Shell me={me}><div className="empty">Belum ada outlet.</div></Shell>;
  const id = encodeURIComponent(outlet.id);
  const [rows, counts, paper] = await authed(() => Promise.all([api<StockRow[]>(`/v1/outlets/${id}/stock`), api<CountRow[]>(`/v1/outlets/${id}/stock/counts?limit=30`), api<PaperRolls>(`/v1/outlets/${id}/paper-rolls`)]));
  const low = rows.filter((r) => r.status === 'LOW' || r.status === 'EMPTY').length;

  return (
    <Shell me={me}>
      <h1>Stok</h1>
      <p className="sub">{outlet.name}{low > 0 ? ` · ${low} bahan menipis atau habis` : ''}</p>
      {outlets.length > 1 && (
        <nav className="tabs" aria-label="Outlet">
          {outlets.map((o) => (
            <Link key={o.id} className="tab" href={`/stock?outlet=${encodeURIComponent(o.id)}`} aria-current={o.id === outlet.id ? 'page' : undefined}>{o.name}</Link>
          ))}
        </nav>
      )}
      <StockBoard outletId={outlet.id} rows={rows} counts={counts} />
      <PaperPanel outletId={outlet.id} paper={paper} />
    </Shell>
  );
}
