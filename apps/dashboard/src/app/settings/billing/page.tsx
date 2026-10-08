import Link from 'next/link';
import { SettingsNav } from '@/components/SettingsNav';
import { Shell } from '@/components/Shell';
import { api, authed, type Billing, type Me, type SubscriptionStatus } from '@/lib/api';
import { rp, shortDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

const STATUS: Record<SubscriptionStatus, { label: string; tone: string }> = {
  TRIAL: { label: 'Uji coba', tone: 'pos' }, ACTIVE: { label: 'Aktif', tone: 'pos' }, DUE: { label: 'Menunggu pembayaran', tone: '' },
  OVERDUE: { label: 'Tertunggak', tone: 'neg' }, CANCELED: { label: 'Dihentikan', tone: '' },
};
const INV: Record<string, string> = { ISSUED: 'Belum dibayar', PAID: 'Lunas', VOID: 'Dibatalkan' };

export default async function BillingPage() {
  const me = await authed(() => api<Me>('/v1/me'));
  if (me.role !== 'OWNER') return <Shell me={me}><div className="empty">Langganan hanya dapat dilihat oleh owner.</div></Shell>;
  const b = await authed(() => api<Billing>('/v1/billing'));
  const s = b.subscription;
  return (
    <Shell me={me}>
      <h1>Pengaturan</h1>
      <SettingsNav active="billing" role={me.role} />
      {!s ? (
        <section className="panel"><h2>Langganan</h2><p className="muted">Akun Anda belum memakai penagihan (masa percobaan khusus). Tidak ada tagihan.</p></section>
      ) : (
        <>
          <section className="panel">
            <h2>Langganan</h2>
            <div className="tiles">
              <div className="tile"><span>Status</span><b className={`delta ${STATUS[s.status].tone}`}>{STATUS[s.status].label}</b>{s.status === 'TRIAL' && <small>{s.trialDaysLeft} hari lagi (sampai {s.trialEnd})</small>}</div>
              <div className="tile"><span>Paket</span><b>{s.planName}</b><small>{rp(s.pricePerOutlet)} per outlet per bulan</small></div>
              <div className="tile"><span>Outlet</span><b>{s.outlets}</b><small>perkiraan {rp(s.monthlyAmount)} per bulan</small></div>
              <div className="tile"><span>Dibayar sampai</span><b>{s.paidThrough ?? '–'}</b></div>
            </div>
            <p className="muted small" style={{ marginBottom: 0 }}>
              Tagihan periode berikutnya terbit 7 hari sebelum periodenya mulai, dengan jumlah outlet pada saat itu. Layanan tidak dihentikan otomatis; tagihan yang lewat jatuh tempo lebih dari 7 hari ditandai tertunggak.
            </p>
          </section>

          <section className="panel">
            <h2>Cara membayar</h2>
            <p style={{ whiteSpace: 'pre-line', marginTop: 0 }}>{b.paymentInfo}</p>
            <p className="muted small" style={{ marginBottom: 0 }}>Sertakan nomor faktur pada berita transfer. Pembayaran dicatat oleh tim kami dan status berubah menjadi Lunas.</p>
          </section>

          <section className="panel">
            <h2>Tagihan</h2>
            <table className="table">
              <thead><tr><th>Faktur</th><th>Periode</th><th className="num">Jumlah</th><th>Jatuh tempo</th><th>Status</th></tr></thead>
              <tbody>
                {b.invoices.map((i) => (
                  <tr key={i.id} className={i.status === 'VOID' ? 'off' : ''}>
                    <td data-label="Faktur"><Link href={`/settings/billing/${encodeURIComponent(i.id)}`}>{i.id}</Link></td>
                    <td data-label="Periode">{shortDate(i.periodStart)} – {shortDate(i.periodEnd)}</td>
                    <td data-label="Jumlah" className="num">{rp(i.amount)}<div className="muted small">{i.outlets} outlet</div></td>
                    <td data-label="Jatuh tempo">{shortDate(i.dueDate)}</td>
                    <td data-label="Status">{INV[i.status]}{i.paidAt ? <div className="muted small">{i.payMethod}{i.payRef ? ` · ${i.payRef}` : ''}</div> : null}</td>
                  </tr>
                ))}
                {b.invoices.length === 0 && <tr><td colSpan={5} className="muted">Belum ada tagihan. Tagihan pertama terbit 7 hari sebelum uji coba berakhir.</td></tr>}
              </tbody>
            </table>
          </section>
        </>
      )}
    </Shell>
  );
}
