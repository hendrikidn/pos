import { useState } from 'react';
import { Modal } from './dialogs';
import { rp, type Ctx } from './ui';

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
/** Papan dari server lebih tua dari ini ditandai usang. */
const STALE_MS = 120_000;

/**
 * Reservasi hari ini untuk kasir: siapa datang jam berapa, meja, dan uang muka yang bisa dipakai. "Duduk" menandai tamu sudah datang
 * (butuh koneksi, dicatat server) lalu membuka order dine-in di meja yang dipesan, atau memilih meja bila belum ditentukan.
 * Uang muka dipakai lewat metode bayar "Uang muka" di layar pembayaran.
 */
export function ReservationDialog({ ctx, onSeated, onClose }: { ctx: Ctx; onSeated: (tableNo: string | null) => void; onClose: () => void }) {
  const board = ctx.rt.reservations();
  const [busy, setBusy] = useState<number | null>(null);
  const stale = board === null || Date.now() - board.at > STALE_MS;

  async function seat(id: number) {
    setBusy(id);
    const r = await ctx.rt.seatReservation(id);
    setBusy(null);
    if (!r.ok) return ctx.toast(r.message, 'error');
    ctx.toast(`${r.value.guestName} didudukkan${r.value.tableNo ? ` di meja ${r.value.tableNo}` : ''}`, 'info');
    onSeated(r.value.tableNo);
  }

  return (
    <Modal title="Reservasi hari ini" onClose={onClose} wide>
      {stale && <p className="notice">{board === null ? 'Belum terhubung ke server: reservasi belum terlihat.' : 'Data reservasi tertunda lebih dari 2 menit; periksa sambungan.'}</p>}
      {board !== null && board.items.length === 0 && <p className="muted">Tidak ada reservasi dalam 24 jam ke depan.</p>}
      <ul className="pay-list" aria-label="Daftar reservasi">
        {board?.items.map((r) => (
          <li key={r.id}>
            <span>
              <b>{hhmm(r.start)}</b> · {r.guestName} · {r.partySize} orang{r.tableNo ? ` · meja ${r.tableNo}` : ''}
              {r.depositRemaining > 0 && <small> · uang muka {rp(r.depositRemaining)}</small>}
              {r.status === 'SEATED' && <small> · sudah duduk</small>}
            </span>
            {r.status === 'BOOKED' && <button disabled={busy !== null} onClick={() => void seat(r.id)}>{busy === r.id ? '…' : 'Duduk'}</button>}
          </li>
        ))}
      </ul>
      <div className="actions"><button className="secondary" onClick={onClose}>Tutup</button></div>
    </Modal>
  );
}
