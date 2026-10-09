import { useState } from 'react';
import { Modal } from './dialogs';
import { rp, type Ctx } from './ui';

const REASONS = ['Stok habis', 'Outlet sudah tutup', 'Terlalu ramai', 'Menu tidak tersedia'];
const LABEL: Record<string, string> = { GOFOOD: 'GoFood', GRABFOOD: 'GrabFood', SHOPEEFOOD: 'ShopeeFood' };
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
const ago = (ms: number) => Math.max(0, Math.round((Date.now() - ms) / 60_000));

/**
 * Pesanan GoFood/GrabFood/ShopeeFood yang masuk langsung. "Terima" memeriksa menu terminal, mengklaim pesanan di server (hanya satu terminal
 * berhasil), lalu membuat order online yang tertaut ke nomor pesanan platform dan langsung mengirimnya ke dapur. Menu yang belum dipetakan
 * ke menu outlet harus dipetakan manager di dashboard dulu. Pesanan yang dibatalkan platform setelah diterima ditandai di atas daftar.
 */
export function ChannelOrdersDialog({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const board = ctx.rt.channelOrders();
  const [busy, setBusy] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState<number | null>(null);

  async function accept(id: number) {
    setBusy(id);
    const r = await ctx.rt.acceptChannelOrder(id);
    setBusy(null);
    ctx.bump();
    if (!r.ok) return ctx.toast(r.message, 'error');
    ctx.selectOrder(r.value.id);
    ctx.toast(`Pesanan ${r.value.channel ? LABEL[r.value.channel.channel] : ''} ${r.value.channel?.ref ?? ''} diterima: order #${r.value.number} dikirim ke dapur`, 'info');
    onClose();
  }

  async function reject(id: number, reason: string) {
    setBusy(id);
    const r = await ctx.rt.rejectChannelOrder(id, reason);
    setBusy(null);
    setRejecting(null);
    if (!r.ok) return ctx.toast(r.message, 'error');
    ctx.toast('Pesanan ditolak', 'info');
  }

  return (
    <Modal title="Pesanan online" onClose={onClose} wide>
      {board === null && <p className="notice">Belum terhubung ke server: pesanan online belum terlihat.</p>}
      {board?.canceled.map((c) => (
        <p key={`${c.channel}:${c.ref}`} className="notice">{LABEL[c.channel]} {c.ref} dibatalkan oleh platform setelah diterima ({hhmm(c.at)}). Hentikan penyiapannya dan jangan diserahkan ke pengemudi.</p>
      ))}
      {board !== null && board.orders.length === 0 && <p className="muted">Tidak ada pesanan online yang menunggu.</p>}
      {board?.orders.map((o) => {
        const unmapped = o.items.filter((i) => !i.menuId);
        return (
          <section key={o.id} className="tbl-area">
            <h3>{LABEL[o.channel]} · {o.ref}{o.name ? ` · ${o.name}` : ''}</h3>
            <p className="muted">masuk {hhmm(o.receivedAt)} ({ago(o.receivedAt)} mnt lalu) · nilai {rp(o.total)}{o.autoAccept ? ' · terima otomatis aktif' : ''}</p>
            <ul className="pay-list">
              {o.items.map((i, k) => (
                <li key={k}><span>{i.qty}× {i.name}{i.note ? ` — ${i.note}` : ''}{!i.menuId ? ' (belum dipetakan)' : ''}</span><b>{rp(i.qty * i.unitPrice)}</b></li>
              ))}
            </ul>
            {o.note && <p className="notice">Catatan pelanggan: {o.note}</p>}
            {unmapped.length > 0 && <p className="notice">Menu belum dipetakan ke menu outlet; minta manager memetakannya di dashboard (Online › Integrasi), atau tolak pesanan.</p>}
            {rejecting === o.id ? (
              <div className="reasons">
                {REASONS.map((r) => <button key={r} className="secondary" disabled={busy !== null} onClick={() => void reject(o.id, r)}>{r}</button>)}
                <button className="secondary" onClick={() => setRejecting(null)}>Kembali</button>
              </div>
            ) : (
              <div className="actions">
                <button className="secondary" disabled={busy !== null} onClick={() => setRejecting(o.id)}>Tolak</button>
                <button disabled={busy !== null || unmapped.length > 0} onClick={() => void accept(o.id)}>{busy === o.id ? '…' : 'Terima dan kirim ke dapur'}</button>
              </div>
            )}
          </section>
        );
      })}
      <div className="actions"><button className="secondary" onClick={onClose}>Tutup</button></div>
    </Modal>
  );
}
