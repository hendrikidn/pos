import Link from 'next/link';
import { ChannelIntegration } from '@/components/ChannelIntegration';
import { OnlineManager } from '@/components/OnlineManager';
import { Shell } from '@/components/Shell';
import { api, API_URL, authed, type ChannelInboundRow, type ChannelIntegrationView, type ChannelItemMap, type MenuRow, type Me, type OnlineReconciliation, type Outlet, type OutletSettings } from '@/lib/api';
import { RANGE_OPTIONS, rangeText, type RangeValue } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function OnlinePage({ searchParams }: { searchParams: Promise<{ outlet?: string; range?: string }> }) {
  const sp = await searchParams;
  const range: RangeValue = RANGE_OPTIONS.some((o) => o.value === sp.range) ? (sp.range as RangeValue) : '7d';
  const { me, outlets } = await authed(async () => ({ me: await api<Me>('/v1/me'), outlets: await api<Outlet[]>('/v1/outlets') }));
  if (me.role !== 'OWNER' && me.role !== 'OPS' && me.role !== 'MANAGER') return <Shell me={me}><div className="empty">Pesanan online hanya untuk owner, ops, dan manager.</div></Shell>;
  const outlet = outlets.find((o) => o.id === sp.outlet) ?? outlets[0];
  if (!outlet) return <Shell me={me}><div className="empty">Belum ada outlet.</div></Shell>;
  const id = encodeURIComponent(outlet.id);
  const { rec, settings } = await authed(async () => ({
    rec: await api<OnlineReconciliation>(`/v1/outlets/${id}/online/reconciliation?range=${range}`),
    settings: me.role === 'MANAGER' ? null : await api<OutletSettings>(`/v1/outlets/${id}/settings`),
  }));
  const gate = me.role === 'OPS' ? null : await authed(async () => ({
    integrations: (await api<{ integrations: ChannelIntegrationView[] }>(`/v1/outlets/${id}/channel-integrations`)).integrations,
    items: await api<ChannelItemMap>(`/v1/outlets/${id}/channel-items`),
    orders: (await api<{ orders: ChannelInboundRow[] }>(`/v1/outlets/${id}/channel-orders?days=7`)).orders,
    menu: await api<MenuRow[]>('/v1/menu'),
  }));
  const enabled = settings ? settings.online_channels.map((c) => c.channel) : [...new Set(rec.rows.map((r) => r.channel))];
  const href = (o: string, rg: string) => `/online?outlet=${encodeURIComponent(o)}&range=${rg}`;
  return (
    <Shell me={me}>
      <h1>Pesanan online</h1>
      <p className="sub">{outlet.name} · {rangeText(rec.range.from, rec.range.to)}</p>
      <div className="filters">
        {outlets.length > 1 && (
          <nav className="tabs" aria-label="Outlet">
            {outlets.map((o) => <Link key={o.id} className="tab" href={href(o.id, range)} aria-current={o.id === outlet.id ? 'page' : undefined}>{o.name}</Link>)}
          </nav>
        )}
        <nav className="tabs" aria-label="Rentang waktu">
          {RANGE_OPTIONS.map((o) => <Link key={o.value} className="tab" href={href(outlet.id, o.value)} aria-current={o.value === range ? 'page' : undefined}>{o.label}</Link>)}
        </nav>
      </div>
      {gate && <ChannelIntegration outletId={outlet.id} apiUrl={process.env.PUBLIC_API_URL ?? API_URL} isOwner={me.role === 'OWNER'} integrations={gate.integrations} items={gate.items} orders={gate.orders} menu={gate.menu} />}
      <OnlineManager outletId={outlet.id} enabled={enabled} canUpload={me.role !== 'MANAGER'} data={rec} />
    </Shell>
  );
}
