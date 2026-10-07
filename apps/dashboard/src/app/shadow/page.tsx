import Link from 'next/link';
import { ruleLabel } from '@pos/rules/src/labels';
import { BarChart, type Bar } from '@/components/BarChart';
import { LevelBadge, StatusBadge } from '@/components/Badges';
import { IconAlert, IconClock } from '@/components/Icons';
import { Shell } from '@/components/Shell';
import { api, authed, type Me, type Outlet, type ShadowReport } from '@/lib/api';
import { ago, shortDate, weekdayDate, wibDateTime, wibRange } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** Target pilot (SPEC 12): insiden kritis per outlet per minggu ≤ 3, presisi insiden kritis ≥ 30%. */
const TARGET_CRITICAL_PER_WEEK = 3;
const TARGET_PRECISION = 30;

export default async function ShadowPage({ searchParams }: { searchParams: Promise<{ outlet?: string }> }) {
  const sp = await searchParams;
  const { me, outlets } = await authed(async () => ({ me: await api<Me>('/v1/me'), outlets: await api<Outlet[]>('/v1/outlets') }));
  if (me.role !== 'OWNER' && me.role !== 'OPS' && me.role !== 'MANAGER') {
    return <Shell me={me}><div className="empty">Ringkasan shadow hanya untuk owner, ops, dan manager.</div></Shell>;
  }
  const outlet = outlets.find((o) => o.id === sp.outlet) ?? outlets.find((o) => o.shadow?.enabled) ?? outlets[0];
  if (!outlet) return <Shell me={me}><div className="empty">Belum ada outlet.</div></Shell>;

  const r = await authed(() => api<ShadowReport>(`/v1/outlets/${encodeURIComponent(outlet.id)}/shadow`));
  const { state: st, summary: s } = r;
  const now = Date.now();
  const progress = st.pending ? 0 : st.active ? Math.round((st.day / st.days) * 100) : 100;
  const maxRule = Math.max(1, ...s.byRule.map((x) => x.incidents));
  const dayBars: Bar[] = s.byDay.map((d, i) => ({
    axis: s.byDay.length <= 8 || i % Math.ceil(s.byDay.length / 7) === 0 ? shortDate(d.date) : '',
    label: weekdayDate(d.date), value: d.total, detail: d.critical > 0 ? `${d.critical} kritis` : undefined,
  }));
  const overTarget = s.criticalPerWeek !== null && s.criticalPerWeek > TARGET_CRITICAL_PER_WEEK;

  return (
    <Shell me={me}>
      <h1>Ringkasan mode shadow</h1>
      <p className="sub">{outlet.name} · apa yang akan terdeteksi bila notifikasi sudah dinyalakan</p>

      {outlets.length > 1 && (
        <nav className="tabs" aria-label="Outlet">
          {outlets.map((o) => (
            <Link key={o.id} className="tab" href={`/shadow?outlet=${encodeURIComponent(o.id)}`} aria-current={o.id === outlet.id ? 'page' : undefined}>{o.name}</Link>
          ))}
        </nav>
      )}

      <section className="panel" aria-labelledby="status">
        <h2 id="status">Status</h2>
        {!st.enabled ? (
          <p style={{ margin: 0 }}>
            Mode shadow <b>nonaktif</b> di outlet ini: insiden langsung dikirim dan tampil di antrean review.
            {me.role === 'OWNER' && <> Owner dapat mengaktifkannya di <Link href="/settings/outlet">Pengaturan → Outlet</Link>.</>}
          </p>
        ) : st.pending ? (
          <p style={{ margin: 0 }}>Menunggu aktivitas pertama (order, pembayaran, atau sesi sensor). Hitungan {st.days} hari dimulai saat itu.</p>
        ) : (
          <>
            <p style={{ marginTop: 0 }}>
              {st.active ? <>Hari ke-<b>{st.day}</b> dari <b>{st.days}</b>.</> : <>Masa shadow <b>selesai</b>: insiden baru kini dikirim.</>}{' '}
              <span className="muted">Mulai {wibDateTime(st.startedMs!)} · {st.active ? 'berakhir' : 'berakhir pada'} {wibDateTime(st.untilMs!)}</span>
            </p>
            <div className="progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Kemajuan masa shadow">
              <span style={{ width: `${progress}%` }} />
            </div>
          </>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>
          Selama shadow, insiden dihitung dan disimpan tetapi tidak dikirim dan tidak muncul di antrean review. Gunakan hasil di bawah untuk menyetel sensor dan ambang.
        </p>
      </section>

      {s.total === 0 ? (
        <div className="empty">{st.pending ? 'Belum ada data.' : 'Belum ada insiden yang tercatat selama shadow.'}</div>
      ) : (
        <>
          <div className="tiles">
            <div className="tile"><span>Insiden tercatat</span><b>{s.total}</b></div>
            <div className="tile"><span>Kritis</span><b>{s.byLevel.CRITICAL}</b><small>akan dikirim sebagai notifikasi</small></div>
            <div className="tile"><span>Sedang</span><b>{s.byLevel.MEDIUM}</b></div>
            <div className="tile"><span>Rendah</span><b>{s.byLevel.LOW}</b></div>
          </div>

          <section className={`panel ${overTarget ? 'urgent' : ''}`} aria-labelledby="target">
            <h2 id="target" className="with-icon">{overTarget && <IconAlert />} Dibandingkan target pilot</h2>
            <dl className="kv">
              <dt>Kritis per minggu</dt>
              <dd>
                {s.criticalPerWeek === null ? (
                  <span className="muted">Belum cukup data (perlu minimal 3 hari)</span>
                ) : (
                  <>
                    <b>{s.criticalPerWeek.toLocaleString('id-ID')}</b> <span className="muted">perkiraan; target ≤ {TARGET_CRITICAL_PER_WEEK}</span>{' '}
                    <span className={`badge ${overTarget ? 'badge-MEDIUM' : 'badge-ok'}`}>{overTarget ? 'Di atas target' : 'Dalam target'}</span>
                  </>
                )}
              </dd>
              <dt>Presisi kritis</dt>
              <dd>
                {s.criticalPrecision === null ? (
                  <span className="muted">Belum ada insiden kritis yang direview. Review insiden di bawah untuk menghitungnya.</span>
                ) : (
                  <>
                    <b>{s.criticalPrecision}%</b> <span className="muted">dikonfirmasi dari yang direview; target ≥ {TARGET_PRECISION}%</span>{' '}
                    <span className={`badge ${s.criticalPrecision >= TARGET_PRECISION ? 'badge-ok' : 'badge-MEDIUM'}`}>{s.criticalPrecision >= TARGET_PRECISION ? 'Dalam target' : 'Di bawah target'}</span>
                  </>
                )}
              </dd>
              <dt>Sudah direview</dt>
              <dd>{s.reviewed.total} dari {s.total} insiden{s.reviewed.total > 0 && <span className="muted"> · terbukti {s.reviewed.confirmed}, sah {s.reviewed.legit}, alarm palsu {s.reviewed.falseAlarm}, belum jelas {s.reviewed.inconclusive}</span>}</dd>
            </dl>
            {overTarget && <p className="small" style={{ marginBottom: 0 }}>Terlalu banyak insiden kritis membuat alarm diabaikan. Periksa aturan terbanyak di bawah: sering kali penyebabnya sensor yang terhalang atau kalibrasi, bukan kecurangan.</p>}
          </section>

          {dayBars.length > 1 && (
            <section className="panel" aria-labelledby="per-hari">
              <h2 id="per-hari">Insiden per hari</h2>
              <BarChart title="Insiden per hari" data={dayBars} unit="n" unitLabel="insiden" empty="Belum ada insiden." />
            </section>
          )}

          <section className="panel" aria-labelledby="aturan">
            <h2 id="aturan">Aturan yang paling sering terpicu</h2>
            <ul className="hbars hbars-wide">
              {s.byRule.map((x) => (
                <li key={x.rule}>
                  <span className="hb-label">{x.label.charAt(0).toUpperCase() + x.label.slice(1)}</span>
                  <span className="hb-track"><span className="hb-fill" style={{ width: `${(x.incidents / maxRule) * 100}%` }} /></span>
                  <span className="hb-val"><b>{x.incidents}</b> insiden</span>
                </li>
              ))}
            </ul>
          </section>

          <h2 style={{ marginTop: 22 }}>Insiden yang tercatat</h2>
          {r.incidents.map((i) => (
            <Link key={i.id} className={`incident incident-${i.level}`} href={`/incidents/${encodeURIComponent(i.id)}`}>
              <div className="incident-body">
                <div className="incident-top">
                  <LevelBadge level={i.level} />
                  {i.status !== 'OPEN' && <StatusBadge status={i.status} />}
                  <span className="when"><IconClock /> {ago(i.end_ms, now)}</span>
                </div>
                <h3 className="incident-title">
                  {ruleLabel(i.rules[0] ?? '')}
                  {i.rules.length > 1 && <span className="more">+{i.rules.length - 1} indikasi lain</span>}
                </h3>
                <div className="meta">
                  {wibRange(i.start_ms, i.end_ms)}
                  {i.order_ids.length > 0 && <> · Order {i.order_ids.join(', ')}</>}
                  {i.actor_ids.length > 0 && <> · {i.actor_ids.join(', ')}</>}
                </div>
              </div>
              <div className="incident-score" aria-label={`Skor ${i.score}`}><b>{i.score}</b><span>skor</span></div>
            </Link>
          ))}
          {s.total > r.incidents.length && <p className="muted small">Menampilkan {r.incidents.length} insiden terbaru dari {s.total}.</p>}
        </>
      )}
    </Shell>
  );
}
