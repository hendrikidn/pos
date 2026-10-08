import { PrintButton } from '@/components/PrintButton';
import { SettingsNav } from '@/components/SettingsNav';
import { Shell } from '@/components/Shell';
import { api, authed, type InvoiceRow, type Me } from '@/lib/api';
import { rp, shortDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** Faktur untuk dicetak atau disimpan sebagai PDF lewat dialog cetak browser. */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await authed(() => api<Me>('/v1/me'));
  if (me.role !== 'OWNER') return <Shell me={me}><div className="empty">Faktur hanya dapat dilihat oleh owner.</div></Shell>;
  const r = await authed(() => api<{ invoice: InvoiceRow; tenantName: string; paymentInfo: string }>(`/v1/billing/invoices/${encodeURIComponent(id)}`));
  const i = r.invoice;
  return (
    <Shell me={me}>
      <div className="no-print"><h1>Pengaturan</h1><SettingsNav active="billing" role={me.role} /></div>
      <section className="panel invoice">
        <header style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0 }}>Faktur {i.id}</h2>
            <p className="muted" style={{ margin: '4px 0 0' }}>Diterbitkan {i.issuedAt.slice(0, 10)} · jatuh tempo {i.dueDate}</p>
          </div>
          <b style={{ fontSize: 20 }}>{i.status === 'PAID' ? 'LUNAS' : i.status === 'VOID' ? 'DIBATALKAN' : 'BELUM DIBAYAR'}</b>
        </header>
        <p>Kepada: <b>{r.tenantName}</b></p>
        <table className="table">
          <thead><tr><th>Uraian</th><th className="num">Jumlah</th><th className="num">Harga</th><th className="num">Total</th></tr></thead>
          <tbody>
            <tr>
              <td data-label="Uraian">Langganan Anatta POS · {shortDate(i.periodStart)} – {shortDate(i.periodEnd)}</td>
              <td data-label="Jumlah" className="num">{i.outlets} outlet</td>
              <td data-label="Harga" className="num">{rp(i.unitPrice)}</td>
              <td data-label="Total" className="num"><b>{rp(i.amount)}</b></td>
            </tr>
          </tbody>
        </table>
        {i.status === 'PAID' ? (
          <p>Dibayar {i.paidAt?.slice(0, 10)} melalui {i.payMethod}{i.payRef ? ` (${i.payRef})` : ''}.</p>
        ) : (
          <>
            <h3>Cara membayar</h3>
            <p style={{ whiteSpace: 'pre-line' }}>{r.paymentInfo}</p>
            <p className="muted small">Sertakan nomor faktur <b>{i.id}</b> pada berita transfer.</p>
          </>
        )}
        <p className="no-print"><PrintButton label="Cetak / simpan PDF" /></p>
      </section>
    </Shell>
  );
}
