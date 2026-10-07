import Link from 'next/link';
import { Shell } from '@/components/Shell';
import { SettlementForm } from '@/components/SettlementForm';
import { api, authed, type Me, type Outlet, type SettlementList } from '@/lib/api';
import { ago, BATCH_OVERDUE_MS, CHANNEL_LABEL, wibDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

const rp = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;

export default async function SettlementsPage({ searchParams }: { searchParams: Promise<{ outlet?: string }> }) {
  const sp = await searchParams;
  const { me, outlets } = await authed(async () => ({ me: await api<Me>('/v1/me'), outlets: await api<Outlet[]>('/v1/outlets') }));
  const outlet = outlets.find((o) => o.id === sp.outlet) ?? outlets[0];
  if (!outlet) return <Shell me={me}><div className="empty">Belum ada outlet.</div></Shell>;
  const data = await authed(() => api<SettlementList>(`/v1/outlets/${encodeURIComponent(outlet.id)}/settlements`));
  const canWrite = me.role === 'OWNER' || me.role === 'OPS';
  const now = Date.now();

  return (
    <Shell me={me}>
      <h1>Settlement EDC</h1>
      <p className="sub">Slip tutup batch dicocokkan dengan pembayaran non-tunai yang tercatat di POS, per jenis pembayaran.</p>

      {outlets.length > 1 && (
        <nav className="tabs" aria-label="Outlet">
          {outlets.map((o) => (
            <Link key={o.id} className="tab" href={`/settlements?outlet=${encodeURIComponent(o.id)}`} aria-current={o.id === outlet.id ? 'page' : undefined}>{o.name}</Link>
          ))}
        </nav>
      )}

      <div className="notice">
        Slip hanya berisi jumlah dan total per jenis, <b>bukan rincian per transaksi</b>. Bila ada selisih, sistem menunjuk order yang mungkin terkait, tetapi tidak bisa memastikannya. Cek rekaman CCTV pada jam yang tertera di insiden.
      </div>

      {data.edcs.length === 0 && <div className="empty">Belum ada mesin EDC terdaftar. Daftarkan di Pengaturan › Outlet.</div>}
      {data.edcs.map((d) => {
        const overdue = d.last_closed_at_ms === null || now - d.last_closed_at_ms > BATCH_OVERDUE_MS;
        return (
          <div key={d.tid} className="card" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <b>{d.label}</b><span className="muted mono">{d.tid}</span>
            <span className={`badge ${overdue ? 'badge-MEDIUM' : 'badge-ok'}`}>
              {d.last_closed_at_ms === null ? 'Belum ada slip' : `Batch terakhir ditutup ${ago(d.last_closed_at_ms, now)}`}
            </span>
            {overdue && d.last_closed_at_ms !== null && <span className="muted small">Pembayaran sejak itu belum bisa dicocokkan.</span>}
          </div>
        );
      })}

      {canWrite && data.edcs.length > 0 && <SettlementForm outletId={outlet.id} edcs={data.edcs} />}

      <h2 style={{ marginTop: 22 }}>Batch tersimpan</h2>
      {data.batches.length === 0 && <div className="empty">Belum ada slip yang dimasukkan.</div>}
      {data.batches.map((b) => {
        const allOk = b.result.channels.every((c) => c.ok);
        return (
          <section key={`${b.tid}-${b.batch}`} className="panel">
            <h3 style={{ marginTop: 0 }}>
              Batch {b.batch} <span className="muted mono small">TID {b.tid}</span>{' '}
              <span className={`badge ${allOk ? 'badge-ok' : 'badge-CRITICAL'}`}>{allOk ? 'Cocok' : 'Ada selisih'}</span>
            </h3>
            <p className="muted small">Ditutup {wibDateTime(b.closed_at_ms)} · dimasukkan oleh {b.uploaded_by}</p>
            <table className="table">
              <thead><tr><th>Jenis</th><th className="num">POS</th><th className="num">Slip</th><th /></tr></thead>
              <tbody>
                {b.result.channels.map((c) => (
                  <tr key={c.channel}>
                    <td>{CHANNEL_LABEL[c.channel] ?? c.channel}</td>
                    <td className="num">{c.pos.count} · {rp(c.pos.amount)}</td>
                    <td className="num">{c.slip.count} · {rp(c.slip.amount)}</td>
                    <td>{c.ok ? '✓' : `Selisih ${c.pos.count - c.slip.count} transaksi · ${c.pos.amount - c.slip.amount > 0 ? '+' : ''}${rp(c.pos.amount - c.slip.amount)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {b.result.notes.map((n, i) => <p key={i} className="muted small">{n}</p>)}
            {!allOk && <p className="small"><Link href={`/?outlet=${encodeURIComponent(outlet.id)}`}>Lihat insiden terkait →</Link></p>}
          </section>
        );
      })}
    </Shell>
  );
}
