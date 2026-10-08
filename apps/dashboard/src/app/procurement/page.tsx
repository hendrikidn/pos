import Link from 'next/link';
import { ProcurementManager } from '@/components/ProcurementManager';
import { Shell } from '@/components/Shell';
import { api, authed, type IngredientCostRow, type Me, type Outlet, type PayableRow, type PoDetail, type PoRow, type SupplierRow, type TransferRow } from '@/lib/api';

export const dynamic = 'force-dynamic';

const VIEWS = [['po', 'Pesanan pembelian'], ['suppliers', 'Supplier'], ['payables', 'Utang supplier'], ['transfers', 'Transfer stok']] as const;
type View = (typeof VIEWS)[number][0];

export default async function ProcurementPage({ searchParams }: { searchParams: Promise<{ outlet?: string; view?: string }> }) {
  const sp = await searchParams;
  const view: View = VIEWS.some(([v]) => v === sp.view) ? (sp.view as View) : 'po';
  const { me, outlets } = await authed(async () => ({ me: await api<Me>('/v1/me'), outlets: await api<Outlet[]>('/v1/outlets') }));
  if (me.role !== 'OWNER' && me.role !== 'OPS' && me.role !== 'MANAGER') return <Shell me={me}><div className="empty">Pengadaan hanya untuk owner, ops, dan manager.</div></Shell>;
  const outlet = outlets.find((o) => o.id === sp.outlet) ?? outlets[0];
  if (!outlet) return <Shell me={me}><div className="empty">Belum ada outlet.</div></Shell>;
  const oid = encodeURIComponent(outlet.id);
  const data = await authed(async () => {
    const [pos, suppliers, payables, ingredients, transfers] = await Promise.all([
      api<PoRow[]>(`/v1/purchase-orders?outletId=${oid}`), api<SupplierRow[]>('/v1/suppliers'), api<PayableRow[]>('/v1/suppliers-payables'), api<IngredientCostRow[]>('/v1/ingredients'), api<TransferRow[]>(`/v1/stock-transfers?outletId=${oid}`),
    ]);
    const open = pos.filter((p) => ['DRAFT', 'ORDERED', 'PARTIAL'].includes(p.status));
    const details = await Promise.all(open.map((p) => api<PoDetail>(`/v1/purchase-orders/${p.id}`)));
    return { pos, suppliers, payables, ingredients, details, transfers };
  });
  const href = (o: string, v: string) => `/procurement?outlet=${encodeURIComponent(o)}&view=${v}`;
  return (
    <Shell me={me}>
      <h1>Pengadaan</h1>
      <p className="sub">{outlet.name}</p>
      <div className="filters">
        {outlets.length > 1 && (
          <nav className="tabs" aria-label="Outlet">
            {outlets.map((o) => <Link key={o.id} className="tab" href={href(o.id, view)} aria-current={o.id === outlet.id ? 'page' : undefined}>{o.name}</Link>)}
          </nav>
        )}
        <nav className="tabs" aria-label="Tampilan">
          {VIEWS.map(([v, l]) => <Link key={v} className="tab" href={href(outlet.id, v)} aria-current={v === view ? 'page' : undefined}>{l}</Link>)}
        </nav>
      </div>
      <ProcurementManager view={view} outletId={outlet.id} outlets={outlets.map((o) => ({ id: o.id, name: o.name }))} role={me.role} {...data} />
    </Shell>
  );
}
