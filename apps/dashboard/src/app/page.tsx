import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ruleLabel } from '@pos/rules/src/labels';
import { LevelBadge, RuleChips, StatusBadge } from '@/components/Badges';
import { IconClock, IconInfo } from '@/components/Icons';
import { Shell } from '@/components/Shell';
import { api, authed, type Incident, type Me, type Outlet } from '@/lib/api';
import { ago, cctvInfo, wibRange } from '@/lib/format';

export const dynamic = 'force-dynamic';

const DONE = ['CONFIRMED_FRAUD', 'LEGIT', 'FALSE_ALARM', 'INCONCLUSIVE'] as const;

async function load(outletId: string, tab: 'open' | 'done'): Promise<Incident[]> {
  if (tab === 'open') return api<Incident[]>(`/v1/outlets/${encodeURIComponent(outletId)}/incidents?status=OPEN`);
  const lists = await Promise.all(
    DONE.map((s) => api<Incident[]>(`/v1/outlets/${encodeURIComponent(outletId)}/incidents?status=${s}`)),
  );
  return lists.flat().sort((a, b) => b.start_ms - a.start_ms);
}

export default async function Home({ searchParams }: { searchParams: Promise<{ outlet?: string; tab?: string }> }) {
  const sp = await searchParams;
  const tab = sp.tab === 'done' ? 'done' : 'open';

  const { me, outlets } = await authed(async () => ({
    me: await api<Me>('/v1/me'),
    outlets: await api<Outlet[]>('/v1/outlets'),
  }));
  if (outlets.length === 0) {
    return (
      <Shell me={me}>
        <div className="empty">Belum ada outlet untuk akun ini.</div>
      </Shell>
    );
  }
  // Tanpa pilihan eksplisit, buka outlet yang paling butuh perhatian (kritis terbanyak, lalu terbuka terbanyak).
  const busiest = [...outlets].sort(
    (a, b) => (b.open_critical ?? 0) - (a.open_critical ?? 0) || (b.open_incidents ?? 0) - (a.open_incidents ?? 0),
  )[0];
  const outlet = outlets.find((o) => o.id === sp.outlet) ?? busiest;
  if (!outlet) notFound();

  const rank = { CRITICAL: 0, MEDIUM: 1, LOW: 2 } as const;
  const incidents = (await authed(() => load(outlet.id, tab))).sort(
    (a, b) => (tab === 'open' ? rank[a.level] - rank[b.level] : 0) || b.start_ms - a.start_ms,
  );
  const now = Date.now();
  const counts = { CRITICAL: 0, MEDIUM: 0, LOW: 0 };
  if (tab === 'open') for (const i of incidents) counts[i.level]++;

  const href = (o: string, t: string) => `/?outlet=${encodeURIComponent(o)}&tab=${t}`;

  return (
    <Shell me={me}>
      <h1>{outlet.name}</h1>
      <p className="sub">Anomali transaksi yang perlu dicek dengan rekaman CCTV.</p>

      {outlets.length > 1 && (
        <nav className="tabs" aria-label="Outlet">
          {outlets.map((o) => (
            <Link key={o.id} className="tab" href={href(o.id, tab)} aria-current={o.id === outlet.id ? 'page' : undefined}>
              {o.name}
              {(o.open_incidents ?? 0) > 0 && <> · {o.open_incidents}</>}
            </Link>
          ))}
        </nav>
      )}

      <div className="notice">
        <IconInfo />
        <span>Insiden adalah <b>indikasi</b>, bukan bukti. Pastikan dengan rekaman CCTV sebelum menyimpulkan atau mengambil tindakan terhadap karyawan.</span>
      </div>

      {tab === 'open' && (
        <div className="stats">
          <div className="stat stat-CRITICAL"><b>{counts.CRITICAL}</b><span>Kritis</span></div>
          <div className="stat stat-MEDIUM"><b>{counts.MEDIUM}</b><span>Sedang</span></div>
          <div className="stat stat-LOW"><b>{counts.LOW}</b><span>Rendah</span></div>
        </div>
      )}

      <nav className="tabs" aria-label="Status">
        <Link className="tab" href={href(outlet.id, 'open')} aria-current={tab === 'open' ? 'page' : undefined}>Perlu review</Link>
        <Link className="tab" href={href(outlet.id, 'done')} aria-current={tab === 'done' ? 'page' : undefined}>Sudah direview</Link>
      </nav>

      {incidents.length === 0 ? (
        <div className="empty">{tab === 'open' ? 'Tidak ada insiden yang perlu direview.' : 'Belum ada insiden yang direview.'}</div>
      ) : (
        incidents.map((i) => {
          const cctv = cctvInfo(i.start_ms, i.end_ms, outlet.cctv_retention_days, outlet.cctv_clock_offset_sec, now);
          // Temuan terberat jadi judul; sisanya tampil sebagai chip kecil.
          const main = [...i.hits].sort((a, b) => b.weight - a.weight)[0];
          const others = [...new Set(i.hits.map((h) => h.rule))].filter((r) => r !== main?.rule);
          return (
            <Link key={i.id} className={`incident incident-${i.level}`} href={`/incidents/${encodeURIComponent(i.id)}`}>
              <div className="incident-body">
                <div className="incident-top">
                  <LevelBadge level={i.level} />
                  {tab === 'done' && <StatusBadge status={i.status} />}
                  {tab === 'open' && cctv.status === 'URGENT' && <span className="badge badge-CRITICAL">Rekaman segera tertimpa</span>}
                  {tab === 'open' && cctv.status === 'EXPIRED' && <span className="badge badge-MEDIUM">Rekaman mungkin sudah tertimpa</span>}
                  <span className="when"><IconClock /> {ago(i.end_ms, now)}</span>
                </div>
                <h3 className="incident-title">{main ? ruleLabel(main.rule) : 'Insiden'}</h3>
                <div className="meta">
                  {wibRange(i.start_ms, i.end_ms)}
                  {i.order_ids.length > 0 && <> · Order {i.order_ids.join(', ')}</>}
                  {i.actor_ids.length > 0 && <> · {i.actor_ids.join(', ')}</>}
                </div>
                {others.length > 0 && <RuleChips rules={others} />}
              </div>
              <div className="incident-score" aria-label={`Skor ${i.score}`}>
                <b>{i.score}</b>
                <span>skor</span>
              </div>
            </Link>
          );
        })
      )}
    </Shell>
  );
}
