import Link from 'next/link';
import { BarChart, type Bar } from '@/components/BarChart';
import { IconAlert } from '@/components/Icons';
import { Shell } from '@/components/Shell';
import { api, authed, type Me, type Outlet, type SalesReport } from '@/lib/api';
import { RANGE_OPTIONS, rangeText, rp, shortDate, weekdayDate, wibDateTime, type RangeValue } from '@/lib/format';

export const dynamic = 'force-dynamic';

const METHOD_LABEL: Record<string, string> = { CASH: 'Tunai', QRIS: 'QRIS', EDC_DEBIT: 'Kartu debit', EDC_CREDIT: 'Kartu kredit' };

/** Jam yang ditampilkan: dari satu jam sebelum aktivitas pertama sampai satu jam sesudah yang terakhir (minimal 8 jam). */
function activeHours<T extends { hour: number; orders: number; net: number }>(rows: T[]): T[] {
  const active = rows.filter((r) => r.orders > 0 || r.net !== 0).map((r) => r.hour);
  if (active.length === 0) return rows;
  let lo = Math.max(0, Math.min(...active) - 1);
  let hi = Math.min(23, Math.max(...active) + 1);
  while (hi - lo + 1 < 8) {
    if (lo > 0) lo--;
    if (hi - lo + 1 < 8 && hi < 23) hi++;
  }
  return rows.filter((r) => r.hour >= lo && r.hour <= hi);
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ outlet?: string; range?: string }> }) {
  const sp = await searchParams;
  const range: RangeValue = RANGE_OPTIONS.some((o) => o.value === sp.range) ? (sp.range as RangeValue) : '7d';
  const { me, outlets } = await authed(async () => ({ me: await api<Me>('/v1/me'), outlets: await api<Outlet[]>('/v1/outlets') }));

  if (me.role !== 'OWNER' && me.role !== 'OPS' && me.role !== 'MANAGER') {
    return <Shell me={me}><div className="empty">Laporan penjualan hanya untuk owner, ops, dan manager.</div></Shell>;
  }
  const outlet = outlets.find((o) => o.id === sp.outlet) ?? outlets[0];
  if (!outlet) return <Shell me={me}><div className="empty">Belum ada outlet.</div></Shell>;

  const r = await authed(() => api<SalesReport>(`/v1/outlets/${encodeURIComponent(outlet.id)}/reports/sales?range=${range}`));
  const href = (o: string, rg: string) => `/reports?outlet=${encodeURIComponent(o)}&range=${rg}`;
  const t = r.totals;
  const single = r.range.days === 1;
  const after = t.voids.afterPayment;
  const afterBy = r.byCashier.filter((c) => c.voidsAfterPayment > 0);
  const methodTotal = r.byMethod.reduce((s, m) => s + Math.max(0, m.amount), 0);
  const tol = r.cashCounts.toleranceAmount;

  const dayBars: Bar[] = r.byDay.map((d) => ({
    axis: r.byDay.length <= 8 || d.date === r.range.from || d.date === r.range.to || r.byDay.indexOf(d) % Math.ceil(r.byDay.length / 6) === 0 ? shortDate(d.date) : '',
    label: weekdayDate(d.date), value: d.net, detail: `${d.orders} order`,
  }));
  const hours = activeHours(r.byHour);
  const hourLabel = (h: number) => `${String(h).padStart(2, '0')}.00–${String(h).padStart(2, '0')}.59`;
  const hourSales: Bar[] = hours.map((h) => ({ axis: h.hour % 2 === 0 ? String(h.hour).padStart(2, '0') : '', label: hourLabel(h.hour), value: h.net, detail: `${h.orders} order` }));
  const hourOrders: Bar[] = hours.map((h) => ({ axis: h.hour % 2 === 0 ? String(h.hour).padStart(2, '0') : '', label: hourLabel(h.hour), value: h.orders }));

  return (
    <Shell me={me}>
      <h1>Laporan penjualan</h1>
      <p className="sub">{outlet.name} · {rangeText(r.range.from, r.range.to)}</p>

      <div className="filters">
        {outlets.length > 1 && (
          <nav className="tabs" aria-label="Outlet">
            {outlets.map((o) => (
              <Link key={o.id} className="tab" href={href(o.id, range)} aria-current={o.id === outlet.id ? 'page' : undefined}>{o.name}</Link>
            ))}
          </nav>
        )}
        <nav className="tabs" aria-label="Rentang waktu">
          {RANGE_OPTIONS.map((o) => (
            <Link key={o.value} className="tab" href={href(outlet.id, o.value)} aria-current={o.value === range ? 'page' : undefined}>{o.label}</Link>
          ))}
        </nav>
      </div>

      <section className="hero panel" aria-label="Penjualan bersih">
        <span className="hero-label">Penjualan bersih</span>
        <b className="hero-value">{rp(t.net)}</b>
        <span className="hero-sub">Penerimaan {rp(t.gross)} − refund {rp(t.refunds)}</span>
      </section>

      <div className="tiles">
        <div className="tile"><span>Order</span><b>{t.orders.toLocaleString('id-ID')}</b></div>
        <div className="tile"><span>Rata-rata per order</span><b>{rp(t.avgOrder)}</b></div>
        <div className="tile"><span>Diskon</span><b>{rp(t.discount.amount)}</b><small>{t.discount.count} kali</small></div>
        <div className="tile"><span>Refund</span><b>{rp(t.refunds)}</b></div>
        <div className="tile"><span>Void</span><b>{t.voids.count}</b><small>{rp(t.voids.amount)}</small></div>
      </div>

      <section className={`panel ${after.count > 0 ? 'urgent' : ''}`} aria-labelledby="void-paid">
        <h2 id="void-paid" className="with-icon">{after.count > 0 && <IconAlert />} Void setelah dibayar</h2>
        {after.count === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Tidak ada order yang dibatalkan setelah uangnya diterima pada rentang ini.</p>
        ) : (
          <>
            <p style={{ marginTop: 0 }}>
              <b>{after.count} order</b> dibatalkan setelah pembayarannya diterima, total <b>{rp(after.amount)}</b>.
              Order ini tidak dihitung sebagai penjualan. Pastikan uangnya benar-benar dikembalikan ke customer: cek rekaman CCTV pada jam void.
            </p>
            <ul className="plain">
              {afterBy.map((c) => <li key={c.userId}><b>{c.userId}</b>: {c.voidsAfterPayment} order</li>)}
            </ul>
            <p className="small" style={{ marginBottom: 0 }}><Link href={`/?outlet=${encodeURIComponent(outlet.id)}`}>Lihat insiden terkait →</Link></p>
          </>
        )}
      </section>

      {!single && (
        <section className="panel" aria-labelledby="per-hari">
          <h2 id="per-hari">Penjualan per hari</h2>
          <BarChart title="Penjualan per hari" data={dayBars} unit="rp" empty="Belum ada penjualan pada rentang ini." />
        </section>
      )}

      <section className="panel" aria-labelledby="per-jam">
        <h2 id="per-jam">{single ? 'Penjualan per jam' : 'Jam ramai (jumlah order per jam)'}</h2>
        <BarChart
          title={single ? 'Penjualan per jam' : 'Order per jam'}
          data={single ? hourSales : hourOrders}
          unit={single ? 'rp' : 'n'}
          empty="Belum ada penjualan pada rentang ini."
        />
      </section>

      <section className="panel" aria-labelledby="metode">
        <h2 id="metode">Metode pembayaran</h2>
        {methodTotal === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Belum ada pembayaran pada rentang ini.</p>
        ) : (
          <ul className="hbars">
            {r.byMethod.filter((m) => m.payments > 0 || m.amount !== 0).map((m) => {
              const share = Math.round((Math.max(0, m.amount) / methodTotal) * 100);
              return (
                <li key={m.method}>
                  <span className="hb-label">{METHOD_LABEL[m.method]}</span>
                  <span className="hb-track"><span className="hb-fill" style={{ width: `${share}%` }} /></span>
                  <span className="hb-val"><b>{rp(m.amount)}</b> · {share}%</span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>Nilai sudah dikurangi refund pada metode yang sama.</p>
      </section>

      <section className="panel" aria-labelledby="kasir">
        <h2 id="kasir">Per kasir</h2>
        {r.byCashier.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Belum ada aktivitas kasir pada rentang ini.</p>
        ) : (
          <table className="table">
            <thead><tr><th>Kasir</th><th className="num">Order</th><th className="num">Penjualan</th><th className="num">Void</th><th className="num">Refund</th><th className="num">Diskon</th></tr></thead>
            <tbody>
              {r.byCashier.map((c) => (
                <tr key={c.userId}>
                  <td data-label="Kasir"><b>{c.userId}</b></td>
                  <td className="num" data-label="Order">{c.orders}</td>
                  <td className="num" data-label="Penjualan">{rp(c.sales)}</td>
                  <td className="num" data-label="Void">
                    <span className="nowrap">{c.voids}{c.voids > 0 && <> · {rp(c.voidAmount)}</>}</span>
                    {c.voidsAfterPayment > 0 && <span className="badge badge-CRITICAL cell-badge">{c.voidsAfterPayment} setelah dibayar</span>}
                  </td>
                  <td className="num" data-label="Refund"><span className="nowrap">{c.refunds}{c.refunds > 0 && <> · {rp(c.refundAmount)}</>}</span></td>
                  <td className="num" data-label="Diskon"><span className="nowrap">{c.discounts}{c.discounts > 0 && <> · {rp(c.discountAmount)}</>}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel" aria-labelledby="kas">
        <h2 id="kas">Selisih kas saat tutup shift</h2>
        {r.cashCounts.shifts.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Belum ada shift yang ditutup pada rentang ini.</p>
        ) : (
          <table className="table">
            <thead><tr><th>Ditutup</th><th>Kasir</th><th className="num">Dihitung</th><th className="num">Seharusnya</th><th className="num">Selisih</th></tr></thead>
            <tbody>
              {r.cashCounts.shifts.map((s) => {
                const off = Math.abs(s.diff) > tol;
                return (
                  <tr key={`${s.terminalId}-${s.shiftId}`}>
                    <td data-label="Ditutup">{wibDateTime(s.at)}</td>
                    <td data-label="Kasir">{s.userId ?? '—'}</td>
                    <td className="num" data-label="Dihitung">{rp(s.counted)}</td>
                    <td className="num" data-label="Seharusnya">{rp(s.expected)}</td>
                    <td className="num" data-label="Selisih">
                      {s.diff === 0 ? 'Pas' : (
                        <span className={off ? 'badge badge-MEDIUM' : undefined}>{s.diff < 0 ? 'Kurang' : 'Lebih'} {rp(Math.abs(s.diff))}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>
          Selisih di atas {rp(tol)} ditandai. Bila berulang pada kasir yang sama, sistem membuat insiden tersendiri.
        </p>
      </section>

      <section className="notes" aria-label="Catatan">
        {t.employeeMeals > 0 && <p>{t.employeeMeals} order karyawan pada rentang ini tidak dihitung sebagai penjualan.</p>}
        {r.notes.map((n, i) => <p key={i}>{n}</p>)}
      </section>
    </Shell>
  );
}
