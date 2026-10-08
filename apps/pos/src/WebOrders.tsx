import { useState } from 'react';
import { Modal } from './dialogs';
import { rp, type Ctx } from './ui';

const REASONS = ['Stok habis', 'Outlet sudah tutup', 'Pesanan tidak jelas', 'Terlalu ramai'];
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
const ago = (ms: number) => Math.max(0, Math.round((Date.now() - ms) / 60_000));

/**
 * Pesanan dari toko web yang menunggu kasir. "Terima" memeriksa menu terminal, mengklaim pesanan di server (hanya satu terminal berhasil),
 * lalu membuat order kasir yang tertaut; pelanggan membayar di kasir seperti biasa. Pesanan yang diterima tetapi tidak jadi penjualan
 * (di-void, tidak dibayar, atau dibayar jauh di bawah nilainya) menjadi temuan di dashboard.
 */
export function WebOrdersDialog({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const board = ctx.rt.webOrders();
  const [busy, setBusy] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState<number | null>(null);

  async function accept(id: number) {
    setBusy(id);
    const r = await ctx.rt.acceptWebOrder(id);
    setBusy(null);
    ctx.bump();
    if (!r.ok) return ctx.toast(r.message, 'error');
    ctx.selectOrder(r.value.id);
    ctx.toast(`Pesanan ${r.value.webOrder?.code ?? ''} diterima: order #${r.value.number}`, 'info');
    onClose();
  }

  async function reject(id: number, reason: string) {
    setBusy(id);
    const r = await ctx.rt.rejectWebOrder(id, reason);
    setBusy(null);
    setRejecting(null);
    if (!r.ok) return ctx.toast(r.message, 'error');
    ctx.toast('Pesanan ditolak', 'info');
  }

  return (
    <Modal title="Pesanan web" onClose={onClose} wide>
      {board === null && <p className="notice">Belum terhubung ke server: pesanan web belum terlihat.</p>}
      {board !== null && board.orders.length === 0 && <p className="muted">Tidak ada pesanan web yang menunggu.</p>}
      {board?.orders.map((o) => (
        <section key={o.id} className="tbl-area">
          <h3>{o.code} · {o.name} <small>({o.phone})</small></h3>
          <p className="muted">{o.type === 'DINE_IN' ? `Makan di tempat · meja ${o.tableNo}` : 'Ambil sendiri'} · masuk {hhmm(o.createdAt)} ({ago(o.createdAt)} mnt lalu) · estimasi {rp(o.total)}</p>
          <ul className="pay-list">
            {o.items.map((i, k) => (
              <li key={k}><span>{i.qty}× {i.name}{i.optionNames.length > 0 ? ` (${i.optionNames.join(', ')})` : ''}{i.note ? ` — ${i.note}` : ''}</span><b>{rp(i.qty * i.unitPrice)}</b></li>
            ))}
          </ul>
          {o.note && <p className="notice">Catatan pelanggan: {o.note}</p>}
          {rejecting === o.id ? (
            <div className="reasons">
              {REASONS.map((r) => <button key={r} className="secondary" disabled={busy !== null} onClick={() => void reject(o.id, r)}>{r}</button>)}
              <button className="secondary" onClick={() => setRejecting(null)}>Kembali</button>
            </div>
          ) : (
            <div className="actions">
              <button className="secondary" disabled={busy !== null} onClick={() => setRejecting(o.id)}>Tolak</button>
              <button disabled={busy !== null} onClick={() => void accept(o.id)}>{busy === o.id ? '…' : 'Terima dan buat order'}</button>
            </div>
          )}
        </section>
      ))}
      <div className="actions"><button className="secondary" onClick={onClose}>Tutup</button></div>
    </Modal>
  );
}
