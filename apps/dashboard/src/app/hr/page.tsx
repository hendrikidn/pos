import Link from 'next/link';
import { HrManager } from '@/components/HrManager';
import { Shell } from '@/components/Shell';
import { api, authed, type AttendanceView, type Me, type Outlet, type PayrollDetail, type PayrollRunRow, type StaffPayRow } from '@/lib/api';
import { RANGE_OPTIONS, rangeText, type RangeValue } from '@/lib/format';

export const dynamic = 'force-dynamic';

const VIEWS = [['attendance', 'Absensi'], ['pay', 'Tarif gaji'], ['payroll', 'Penggajian']] as const;
type View = (typeof VIEWS)[number][0];

export default async function HrPage({ searchParams }: { searchParams: Promise<{ outlet?: string; range?: string; view?: string }> }) {
  const sp = await searchParams;
  const range: RangeValue = RANGE_OPTIONS.some((o) => o.value === sp.range) ? (sp.range as RangeValue) : '7d';
  const { me, outlets } = await authed(async () => ({ me: await api<Me>('/v1/me'), outlets: await api<Outlet[]>('/v1/outlets') }));
  if (me.role !== 'OWNER' && me.role !== 'MANAGER') return <Shell me={me}><div className="empty">SDM hanya untuk owner dan manager.</div></Shell>;
  const isOwner = me.role === 'OWNER';
  const views = VIEWS.filter(([v]) => isOwner || v === 'attendance');
  const view: View = views.some(([v]) => v === sp.view) ? (sp.view as View) : 'attendance';
  const outlet = outlets.find((o) => o.id === sp.outlet) ?? outlets[0];
  if (!outlet) return <Shell me={me}><div className="empty">Belum ada outlet.</div></Shell>;
  const oid = encodeURIComponent(outlet.id);
  const data = await authed(async () => {
    const attendance = await api<AttendanceView>(`/v1/outlets/${oid}/hr/attendance?range=${range}`);
    const pay = isOwner && view !== 'attendance' ? await api<StaffPayRow[]>('/v1/hr/pay') : [];
    const runs = isOwner && view === 'payroll' ? await api<PayrollRunRow[]>(`/v1/payroll-runs?outletId=${oid}`) : [];
    const details = await Promise.all(runs.filter((r) => r.status === 'DRAFT' || r.status === 'FINAL').map((r) => api<PayrollDetail>(`/v1/payroll-runs/${r.id}`)));
    return { attendance, pay, runs, details };
  });
  const href = (o: string, rg: string, v: string) => `/hr?outlet=${encodeURIComponent(o)}&range=${rg}&view=${v}`;
  return (
    <Shell me={me}>
      <h1>SDM</h1>
      <p className="sub">{outlet.name} · {rangeText(data.attendance.range.from, data.attendance.range.to)}</p>
      <div className="filters">
        {outlets.length > 1 && (
          <nav className="tabs" aria-label="Outlet">
            {outlets.map((o) => <Link key={o.id} className="tab" href={href(o.id, range, view)} aria-current={o.id === outlet.id ? 'page' : undefined}>{o.name}</Link>)}
          </nav>
        )}
        {view === 'attendance' && (
          <nav className="tabs" aria-label="Rentang waktu">
            {RANGE_OPTIONS.map((o) => <Link key={o.value} className="tab" href={href(outlet.id, o.value, view)} aria-current={o.value === range ? 'page' : undefined}>{o.label}</Link>)}
          </nav>
        )}
        <nav className="tabs" aria-label="Tampilan">
          {views.map(([v, l]) => <Link key={v} className="tab" href={href(outlet.id, range, v)} aria-current={v === view ? 'page' : undefined}>{l}</Link>)}
        </nav>
      </div>
      <HrManager view={view} outletId={outlet.id} isOwner={isOwner} {...data} />
    </Shell>
  );
}
