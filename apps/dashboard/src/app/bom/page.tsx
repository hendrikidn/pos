import Link from 'next/link';
import { BomCalculator, BomPlanView } from '@/components/BomCalculator';
import { Shell } from '@/components/Shell';
import { api, authed, type BomPlan, type Me, type MenuRow, type Outlet } from '@/lib/api';

export const dynamic = 'force-dynamic';

const VIEWS = [['calc', 'Hitung BOM'], ['plan', 'Rencana kebutuhan']] as const;

export default async function BomPage({ searchParams }: { searchParams: Promise<{ outlet?: string; view?: string; days?: string; history?: string }> }) {
  const sp = await searchParams;
  const { me, outlets, menu } = await authed(async () => ({ me: await api<Me>('/v1/me'), outlets: await api<Outlet[]>('/v1/outlets'), menu: await api<MenuRow[]>('/v1/menu') }));
  if (me.role !== 'OWNER' && me.role !== 'OPS' && me.role !== 'MANAGER') return <Shell me={me}><div className="empty">BOM hanya untuk owner, ops, dan manager.</div></Shell>;
  const view = VIEWS.some(([v]) => v === sp.view) ? (sp.view as 'calc' | 'plan') : 'calc';
  const outlet = outlets.find((o) => o.id === sp.outlet) ?? outlets[0];
  const days = [3, 7, 14, 30].includes(Number(sp.days)) ? Number(sp.days) : 7;
  const history = [7, 14, 30].includes(Number(sp.history)) ? Number(sp.history) : 14;
  const plan = view === 'plan' && outlet ? await authed(() => api<BomPlan>(`/v1/outlets/${encodeURIComponent(outlet.id)}/bom/plan?days=${days}&history=${history}`)) : null;
  const href = (v: string, extra = '') => `/bom?view=${v}${outlet ? `&outlet=${encodeURIComponent(outlet.id)}` : ''}${extra}`;
  return (
    <Shell me={me}>
      <h1>Bill of material</h1>
      <p className="sub">Kebutuhan bahan baku dan biaya dari resep, termasuk bahan setengah jadi dan susut</p>
      <div className="filters">
        {outlets.length > 1 && (
          <nav className="tabs" aria-label="Outlet">
            {outlets.map((o) => <Link key={o.id} className="tab" href={`/bom?view=${view}&outlet=${encodeURIComponent(o.id)}`} aria-current={o.id === outlet?.id ? 'page' : undefined}>{o.name}</Link>)}
          </nav>
        )}
        <nav className="tabs" aria-label="Tampilan">
          {VIEWS.map(([v, l]) => <Link key={v} className="tab" href={href(v)} aria-current={v === view ? 'page' : undefined}>{l}</Link>)}
        </nav>
      </div>
      {view === 'calc' && <BomCalculator menu={menu.filter((m) => m.active)} outletId={outlet?.id ?? null} />}
      {view === 'plan' && plan && <BomPlanView plan={plan} outletName={outlet!.name} basePath={href('plan')} />}
      {view === 'plan' && !plan && <div className="empty">Belum ada outlet.</div>}
    </Shell>
  );
}
