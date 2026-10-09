import Link from 'next/link';
import { Shell } from '@/components/Shell';
import { api, authed, type AnnualTax, type Me, type Outlet, type TaxReport } from '@/lib/api';
import { rp } from '@/lib/format';

export const dynamic = 'force-dynamic';

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const label = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

export default async function TaxPage({ searchParams }: { searchParams: Promise<{ outlet?: string; month?: string }> }) {
  const sp = await searchParams;
  const { me, outlets } = await authed(async () => ({ me: await api<Me>('/v1/me'), outlets: await api<Outlet[]>('/v1/outlets') }));
  if (me.role !== 'OWNER' && me.role !== 'OPS' && me.role !== 'MANAGER') return <Shell me={me}><div className="empty">Laporan pajak hanya untuk owner, ops, dan manager.</div></Shell>;
  const outlet = outlets.find((o) => o.id === sp.outlet) ?? outlets[0];
  if (!outlet) return <Shell me={me}><div className="empty">Belum ada outlet.</div></Shell>;
  const now = new Date();
  const months = Array.from({ length: 6 }, (_, i) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; });
  const month = months.includes(sp.month ?? '') ? sp.month! : months[1]!;
  const id = encodeURIComponent(outlet.id);
  const r = await authed(() => api<TaxReport>(`/v1/outlets/${id}/reports/tax?month=${month}`));
  const t = r.totals;
  // Batas bebas PPh Final orang pribadi berlaku atas omzet seluruh usaha, jadi owner melihat gabungan semua outlet; peran lain hanya outlet ini.
  const annualScope = me.role === 'OWNER' ? 'all' : id;
  const annual = await authed(() => api<AnnualTax>(`/v1/outlets/${annualScope}/reports/annual-tax?year=${month.slice(0, 4)}`));
  const href = (o: string, m: string) => `/tax?outlet=${encodeURIComponent(o)}&month=${m}`;
  return (
    <Shell me={me}>
      <h1>Laporan pajak</h1>
      <p className="sub">{outlet.name} · {label(month)} · PBJT {r.outlet.taxPercent}%{r.outlet.servicePercent > 0 ? ` · service ${r.outlet.servicePercent}%${r.outlet.taxOnService ? ' (ikut dikenai pajak)' : ''}` : ''}</p>
      <div className="filters">
        {outlets.length > 1 && (
          <nav className="tabs" aria-label="Outlet">
            {outlets.map((o) => <Link key={o.id} className="tab" href={href(o.id, month)} aria-current={o.id === outlet.id ? 'page' : undefined}>{o.name}</Link>)}
          </nav>
        )}
        <nav className="tabs" aria-label="Bulan">
          {months.map((m) => <Link key={m} className="tab" href={href(outlet.id, m)} aria-current={m === month ? 'page' : undefined}>{label(m)}</Link>)}
        </nav>
      </div>

      <div className="tiles">
        <div className="tile"><span>Dasar pengenaan pajak</span><b>{rp(t.taxBase)}</b></div>
        <div className="tile"><span>PBJT dipungut</span><b>{rp(t.tax)}</b><small>{t.refunds.taxEstimate > 0 ? `neto ${rp(t.netTax)} setelah perkiraan refund` : ''}</small></div>
        <div className="tile"><span>Omzet (di luar pajak)</span><b>{rp(t.omzet)}</b></div>
        <div className="tile"><span>Order</span><b>{t.orders}</b><small>{t.platform.orders > 0 ? `${t.platform.orders} lewat platform` : ''}</small></div>
      </div>

      {r.withoutBreakdown > 0 && <p className="notice">{r.withoutBreakdown} order tidak memuat rincian pajak (data lama), sehingga pajaknya tidak ikut terhitung di atas.</p>}

      <section className="panel no-print">
        <h2>Unduh</h2>
        <div className="export-links">
          <a className="btn-like secondary" href={`/api/tax-export?outlet=${id}&month=${month}`} download>CSV per hari</a>
        </div>
        <ul className="plain muted small">{r.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </section>

      <section className="panel">
        <h2>Setahun {annual.year} · {annualScope === 'all' ? 'semua outlet' : outlet.name}</h2>
        <table className="table">
          <thead><tr><th>Bulan</th><th className="num">Order</th><th className="num">Omzet</th><th className="num">PBJT</th>{annual.umkmFinal && <th className="num">Omzet kumulatif</th>}{annual.umkmFinal && <th className="num">PPh Final</th>}</tr></thead>
          <tbody>
            {annual.months.map((m) => (
              <tr key={m.month}>
                <td data-label="Bulan">{label(m.month)}</td><td data-label="Order" className="num">{m.orders}</td><td data-label="Omzet" className="num">{rp(m.omzet)}</td><td data-label="PBJT" className="num">{rp(m.pbjt)}</td>
                {annual.umkmFinal && <td data-label="Omzet kumulatif" className="num">{rp(m.cumulativeOmzet)}</td>}{annual.umkmFinal && <td data-label="PPh Final" className="num">{rp(m.pphFinal)}</td>}
              </tr>
            ))}
            <tr><th scope="row" colSpan={2}>Total</th><td className="num"><b>{rp(annual.totals.omzet)}</b></td><td className="num"><b>{rp(annual.totals.pbjt)}</b></td>{annual.umkmFinal && <td />}{annual.umkmFinal && <td className="num"><b>{rp(annual.totals.pphFinal)}</b></td>}</tr>
          </tbody>
        </table>
        <ul className="plain muted small">{annual.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </section>

      <section className="panel">
        <h2>Per hari</h2>
        <table className="table">
          <thead><tr><th>Tanggal</th><th className="num">Order</th><th className="num">Subtotal</th><th className="num">Diskon</th><th className="num">Service</th><th className="num">Dasar pajak</th><th className="num">PBJT</th><th className="num">Total tagihan</th></tr></thead>
          <tbody>
            {r.byDay.filter((d) => d.orders > 0).map((d) => (
              <tr key={d.date}>
                <td data-label="Tanggal">{d.date}</td><td data-label="Order" className="num">{d.orders}</td><td data-label="Subtotal" className="num">{rp(d.subtotal)}</td><td data-label="Diskon" className="num">{rp(d.discount)}</td>
                <td data-label="Service" className="num">{rp(d.service)}</td><td data-label="Dasar pajak" className="num">{rp(d.taxBase)}</td><td data-label="PBJT" className="num">{rp(d.tax)}</td><td data-label="Total tagihan" className="num">{rp(d.total)}</td>
              </tr>
            ))}
            {t.orders === 0 && <tr><td colSpan={8} className="muted">Belum ada penjualan di bulan ini.</td></tr>}
            {t.orders > 0 && <tr><th scope="row">Total</th><td className="num"><b>{t.orders}</b></td><td className="num"><b>{rp(t.subtotal)}</b></td><td className="num"><b>{rp(t.discount)}</b></td><td className="num"><b>{rp(t.service)}</b></td><td className="num"><b>{rp(t.taxBase)}</b></td><td className="num"><b>{rp(t.tax)}</b></td><td className="num"><b>{rp(t.total)}</b></td></tr>}
          </tbody>
        </table>
      </section>
    </Shell>
  );
}
