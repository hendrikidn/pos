import Link from 'next/link';
import { ReservationManager } from '@/components/ReservationManager';
import { Shell } from '@/components/Shell';
import { api, authed, type Me, type Outlet, type ReservationList } from '@/lib/api';
import { rangeText } from '@/lib/format';

export const dynamic = 'force-dynamic';

const RANGES = [['today', 'Hari ini', 0], ['7d', '7 hari ke depan', 6], ['30d', '30 hari ke depan', 29]] as const;
const ymd = (offsetDays: number) => new Date(Date.now() + 7 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

export default async function ReservationsPage({ searchParams }: { searchParams: Promise<{ outlet?: string; range?: string }> }) {
  const sp = await searchParams;
  const { me, outlets } = await authed(async () => ({ me: await api<Me>('/v1/me'), outlets: await api<Outlet[]>('/v1/outlets') }));
  if (me.role !== 'OWNER' && me.role !== 'MANAGER') return <Shell me={me}><div className="empty">Reservasi hanya untuk owner dan manager.</div></Shell>;
  const range = RANGES.find(([v]) => v === sp.range) ?? RANGES[1];
  const outlet = outlets.find((o) => o.id === sp.outlet) ?? outlets[0];
  if (!outlet) return <Shell me={me}><div className="empty">Belum ada outlet.</div></Shell>;
  const oid = encodeURIComponent(outlet.id);
  const list = await authed(() => api<ReservationList>(`/v1/outlets/${oid}/reservations?from=${ymd(0)}&to=${ymd(range[2])}`));
  const href = (o: string, r: string) => `/reservations?outlet=${encodeURIComponent(o)}&range=${r}`;
  return (
    <Shell me={me}>
      <h1>Reservasi</h1>
      <p className="sub">{outlet.name} · {rangeText(list.range.from, list.range.to)}</p>
      <div className="filters">
        {outlets.length > 1 && (
          <nav className="tabs" aria-label="Outlet">
            {outlets.map((o) => <Link key={o.id} className="tab" href={href(o.id, range[0])} aria-current={o.id === outlet.id ? 'page' : undefined}>{o.name}</Link>)}
          </nav>
        )}
        <nav className="tabs" aria-label="Rentang waktu">
          {RANGES.map(([v, l]) => <Link key={v} className="tab" href={href(outlet.id, v)} aria-current={v === range[0] ? 'page' : undefined}>{l}</Link>)}
        </nav>
      </div>
      <ReservationManager outletId={outlet.id} list={list} />
    </Shell>
  );
}
