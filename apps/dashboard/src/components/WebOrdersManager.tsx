'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { manage } from '@/lib/manage';
import { rp, wibDateTime } from '@/lib/format';

export interface WebOrderRow {
  id: number; code: string; name: string; phone: string; type: 'TAKE_AWAY' | 'DINE_IN'; tableNo: string | null; note: string | null;
  status: 'NEW' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED'; total: number; createdAt: number; decidedBy: string | null; decidedAt: number | null; reason: string | null;
  items: { name: string; qty: number; unitPrice: number; options: string[]; note: string | null }[];
}
const STATUS = { NEW: 'Menunggu kasir', ACCEPTED: 'Diterima kasir', REJECTED: 'Ditolak', EXPIRED: 'Kedaluwarsa' } as const;

export function WebOrdersManager({ outletId, isOwner, settings, orders, origin }: { outletId: string; isOwner: boolean; settings: { slug: string | null; enabled: boolean; tables: string[] }; orders: WebOrderRow[]; origin: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [slug, setSlug] = useState(settings.slug ?? '');
  const [enabled, setEnabled] = useState(settings.enabled);

  async function act(fn: () => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>, ok: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) return void setError(r.message);
    setNotice(ok);
    router.refresh();
  }

  const link = settings.slug ? `${origin}/shop/${settings.slug}` : null;
  return (
    <>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="ok-note" role="status">{notice}</p>}
      <section className="panel">
        <h2>Alamat toko</h2>
        {link && settings.enabled ? <p>Bagikan: <a href={link} target="_blank" rel="noreferrer">{link}</a></p> : <p className="muted">Pemesanan online belum aktif untuk outlet ini.</p>}
        {settings.enabled && link && settings.tables.length > 0 && (
          <details>
            <summary>Tautan per meja (untuk QR di meja)</summary>
            <ul className="plain">{settings.tables.map((t) => <li key={t}>Meja {t}: <span className="mono small">{link}?meja={encodeURIComponent(t)}</span></li>)}</ul>
          </details>
        )}
        {isOwner ? (
          <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void act(() => manage('PUT', `/v1/outlets/${outletId}/web-shop`, { enabled, slug }), 'Pengaturan disimpan.'); }}>
            <label>Alamat (huruf kecil, angka, tanda hubung)<input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} pattern="[a-z0-9][a-z0-9\-]{2,29}" placeholder="kopi-senopati" /></label>
            <label style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Terima pesanan online</label>
            <div className="form-actions"><button type="submit" disabled={busy}>Simpan</button></div>
          </form>
        ) : <p className="muted small">Hanya owner yang mengatur alamat dan mengaktifkan toko.</p>}
        <p className="muted small" style={{ marginBottom: 0 }}>Pelanggan memesan lewat halaman ini dan membayar di kasir. Pesanan muncul di aplikasi kasir sebagai &quot;Pesanan web&quot;; kasir menerima atau menolaknya. Pesanan yang diterima tetapi tidak jadi penjualan, di-void, atau dibayar jauh di bawah nilainya menjadi temuan di Insiden.</p>
      </section>
      <section className="panel">
        <h2>Pesanan 7 hari terakhir</h2>
        {orders.length === 0 && <p className="muted">Belum ada pesanan web.</p>}
        {orders.length > 0 && (
          <table className="table">
            <thead><tr><th>Pesanan</th><th>Pemesan</th><th>Isi</th><th className="num">Estimasi</th><th>Status</th><th /></tr></thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className={o.status === 'REJECTED' || o.status === 'EXPIRED' ? 'off' : ''}>
                  <td data-label="Pesanan"><b>{o.code}</b><div className="muted small">{wibDateTime(o.createdAt)}<br />{o.type === 'DINE_IN' ? `Meja ${o.tableNo}` : 'Ambil sendiri'}</div></td>
                  <td data-label="Pemesan">{o.name}<div className="muted small">{o.phone}</div></td>
                  <td data-label="Isi">{o.items.map((i, k) => <div key={k} className="small">{i.qty}× {i.name}{i.options.length > 0 ? ` (${i.options.join(', ')})` : ''}</div>)}{o.note && <div className="muted small">Catatan: {o.note}</div>}</td>
                  <td data-label="Estimasi" className="num">{rp(o.total)}</td>
                  <td data-label="Status">{STATUS[o.status]}{o.decidedBy && <div className="muted small">oleh {o.decidedBy.replace('device:', 'terminal ')}</div>}{o.reason && <div className="muted small">{o.reason}</div>}</td>
                  <td className="row-actions">
                    {o.status === 'NEW' && <button className="secondary" disabled={busy} onClick={() => { const reason = window.prompt('Alasan menolak pesanan:'); if (reason) void act(() => manage('POST', `/v1/outlets/${outletId}/web-orders/${o.id}/reject`, { reason }), 'Pesanan ditolak.'); }}>Tolak</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
