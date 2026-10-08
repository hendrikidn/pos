import { headers } from 'next/headers';
import Link from 'next/link';
import { QueueManager, type QueueDay } from '@/components/QueueManager';
import { Shell } from '@/components/Shell';
import { api, authed, type Me, type Outlet } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ outlet?: string }> }) {
  const sp = await searchParams;
  const { me, outlets } = await authed(async () => ({ me: await api<Me>('/v1/me'), outlets: await api<Outlet[]>('/v1/outlets') }));
  if (me.role !== 'OWNER' && me.role !== 'MANAGER') return <Shell me={me}><div className="empty">Antrian hanya untuk owner dan manager.</div></Shell>;
  const outlet = outlets.find((o) => o.id === sp.outlet) ?? outlets[0];
  if (!outlet) return <Shell me={me}><div className="empty">Belum ada outlet.</div></Shell>;
  const oid = encodeURIComponent(outlet.id);
  const data = await authed(async () => ({
    settings: await api<{ slug: string | null; enabled: boolean }>(`/v1/outlets/${oid}/queue-settings`),
    data: await api<QueueDay>(`/v1/outlets/${oid}/queue`),
  }));
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3001';
  const origin = `${h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')}://${host}`;
  return (
    <Shell me={me}>
      <h1>Antrian</h1>
      <p className="sub">{outlet.name}</p>
      {outlets.length > 1 && (
        <nav className="tabs" aria-label="Outlet">
          {outlets.map((o) => <Link key={o.id} className="tab" href={`/queue?outlet=${encodeURIComponent(o.id)}`} aria-current={o.id === outlet.id ? 'page' : undefined}>{o.name}</Link>)}
        </nav>
      )}
      <QueueManager outletId={outlet.id} isOwner={me.role === 'OWNER'} origin={origin} {...data} />
    </Shell>
  );
}
