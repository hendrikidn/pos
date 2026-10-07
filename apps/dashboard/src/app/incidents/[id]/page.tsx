import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ruleLabel } from '@pos/rules/src/labels';
import { LevelBadge, StatusBadge } from '@/components/Badges';
import { CopyButton } from '@/components/CopyButton';
import { ReviewForm } from '@/components/ReviewForm';
import { Shell } from '@/components/Shell';
import { api, ApiError, authed, type IncidentDetail, type Me } from '@/lib/api';
import { cctvInfo, STATUS_LABEL, wibClock, wibDate, wibDateTime, wibRange } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);

  const { me, inc } = await authed(async () => {
    const me = await api<Me>('/v1/me');
    try {
      return { me, inc: await api<IncidentDetail>(`/v1/incidents/${encodeURIComponent(id)}`) };
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) notFound();
      throw e;
    }
  });

  const now = Date.now();
  const cctv = cctvInfo(inc.start_ms, inc.end_ms, inc.outlet.cctv_retention_days, inc.outlet.cctv_clock_offset_sec, now);
  const hits = [...inc.hits].sort((a, b) => a.at - b.at);
  const sum = hits.reduce((s, h) => s + h.weight, 0);
  const canReview = me.role === 'OWNER' || me.role === 'OPS';
  const windowText = `${wibDate(cctv.fromMs)} ${wibClock(cctv.fromMs, true)} – ${wibClock(cctv.toMs, true)}`;
  const last = inc.reviews.at(-1);

  return (
    <Shell me={me}>
      <Link className="back" href={`/?outlet=${encodeURIComponent(inc.outlet_id)}`}>← Kembali ke {inc.outlet.name}</Link>

      <h1>
        <LevelBadge level={inc.level} /> <span className="score">Skor {inc.score}</span>
      </h1>
      <p className="sub">
        {inc.outlet.name} · {wibRange(inc.start_ms, inc.end_ms)} · <StatusBadge status={inc.status} />
      </p>

      <section className={`panel ${cctv.status === 'OK' ? '' : 'urgent'}`} aria-labelledby="cctv">
        <h2 id="cctv">Cek rekaman CCTV</h2>
        <dl className="kv">
          <dt>Jendela rekaman</dt>
          <dd>
            <span className="mono">{windowText}</span> <CopyButton text={windowText} />
            {inc.outlet.cctv_clock_offset_sec !== 0 && (
              <div className="meta">
                Sudah dikoreksi selisih jam NVR {inc.outlet.cctv_clock_offset_sec > 0 ? '+' : ''}{inc.outlet.cctv_clock_offset_sec} detik.
              </div>
            )}
          </dd>
          <dt>Yang dicari</dt>
          <dd>
            Apakah customer sudah menyerahkan pembayaran{inc.order_ids.length > 0 && <> untuk order {inc.order_ids.join(', ')}</>}, dan ke mana pembayaran itu (kasir, QR, atau EDC) tercatat.
          </dd>
          <dt>Ketersediaan</dt>
          <dd>
            {cctv.status === 'EXPIRED' && <b>Rekaman kemungkinan sudah tertimpa</b>}
            {cctv.status === 'URGENT' && <b>Segera ekspor: sisa {Math.max(cctv.daysLeft, 0)} hari</b>}
            {cctv.status === 'OK' && <>Sisa ±{cctv.daysLeft} hari</>}
            <div className="meta">
              Perkiraan dari retensi {inc.outlet.cctv_retention_days} hari (sampai {wibDateTime(cctv.retainedUntilMs)}). Sistem tidak dapat memastikan CCTV benar-benar merekam.
            </div>
          </dd>
        </dl>
      </section>

      <section className="panel" aria-labelledby="bukti">
        <h2 id="bukti">Rangkaian bukti</h2>
        <ol className="timeline">
          {hits.map((h) => (
            <li key={h.key}>
              <time>{wibClock(h.at, true)}</time>
              <div>
                <span className="weight">+{h.weight}</span>
                <div className="rule">
                  {ruleLabel(h.rule)}
                  {h.confidence === 'LOW' && <span className="chip" style={{ marginLeft: 8 }}>keyakinan rendah</span>}
                  {h.context && <span className="chip" style={{ marginLeft: 8 }}>kondisi berlanjut</span>}
                </div>
                <div className="note">{h.note}</div>
                {h.context && (
                  <div className="note">Berlangsung {wibClock(h.windowStart, true)}–{wibClock(h.windowEnd, true)}</div>
                )}
                {h.evidence && h.evidence.length > 0 && (
                  <div className="evidence">
                    <div className="note">Pembayaran yang mungkin terkait. Cek CCTV pada jam ini:</div>
                    <ul>
                      {h.evidence.map((e) => {
                        const c = cctvInfo(e.at, e.at, inc.outlet.cctv_retention_days, inc.outlet.cctv_clock_offset_sec, now);
                        return (
                          <li key={e.orderId}>
                            <span className="mono">{wibClock(e.at, true)}</span> · Rp {e.amount.toLocaleString('id-ID')} · order {e.orderId}
                            {e.actorId && <> · {e.actorId}</>}
                            <div className="muted small mono">CCTV {wibClock(c.fromMs, true)}–{wibClock(c.toMs, true)}</div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
        <div className="formula">
          Jumlah bobot {sum} × pengali {inc.multiplier.toFixed(1)} = <b>{inc.score}</b>
          {' '}(pengali naik bila beberapa aturan terpicu bersamaan dan buktinya berasal dari lebih dari satu sumber).
        </div>
      </section>

      <section className="panel" aria-labelledby="terkait">
        <h2 id="terkait">Pihak dan transaksi terkait</h2>
        <dl className="kv">
          <dt>Staf</dt>
          <dd>{inc.actor_ids.length > 0 ? inc.actor_ids.join(', ') : '—'}</dd>
          <dt>Order</dt>
          <dd>{inc.order_ids.length > 0 ? inc.order_ids.join(', ') : '—'}</dd>
          <dt>Terminal</dt>
          <dd>{inc.terminal_id ?? '—'}</dd>
        </dl>
      </section>

      <section className="panel" aria-labelledby="review">
        <h2 id="review">Review</h2>
        {inc.reviews.length > 0 && (
          <ul className="hist">
            {inc.reviews.map((r, i) => (
              <li key={i}>
                <b>{STATUS_LABEL[r.label] ?? r.label}</b> oleh {r.reviewer} · {r.reviewed_at.replace('T', ' ').replace('Z', ' UTC')}
                {r.note && <div className="note">{r.note}</div>}
              </li>
            ))}
          </ul>
        )}
        {canReview ? (
          <div style={{ marginTop: inc.reviews.length > 0 ? 16 : 0 }}>
            <ReviewForm incidentId={inc.id} current={last?.label} />
          </div>
        ) : (
          <p className="sub">Hanya owner atau ops yang dapat menyimpan hasil review.</p>
        )}
      </section>
    </Shell>
  );
}
