'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export interface PublicQueue { name: string; waiting: number; estimateMin: number; calling: { label: string }[] }
export interface PublicTicket {
  outletName: string; label: string; status: 'WAITING' | 'CALLED' | 'SEATED' | 'NO_SHOW' | 'CANCELED' | 'EXPIRED'; partySize: number; ahead: number; estimateMin: number;
  callCount: number; tableNo: string | null; today: boolean;
}

/** Menyegarkan halaman server secara berkala (papan dan status tiket berubah dari kasir). */
function useRefresh(ms: number, active = true) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), ms);
    return () => clearInterval(id);
  }, [router, ms, active]);
}

/** Halaman antrian untuk pelanggan: lihat siapa yang dipanggil, ambil nomor. */
export function QueueTake({ slug, board }: { slug: string; board: PublicQueue }) {
  const router = useRouter();
  const [form, setForm] = useState({ partySize: '2', name: '', phone: '', website: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useRefresh(8_000);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/antri/${slug}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...form, partySize: Number(form.partySize) }) }).catch(() => null);
    setBusy(false);
    if (!res) return setError('Tidak dapat menghubungi server. Coba lagi.');
    const j = (await res.json().catch(() => ({}))) as { token?: string; message?: string };
    if (!res.ok || !j.token) return setError(j.message ?? 'Gagal mengambil nomor.');
    router.push(`/antri/${slug}/tiket/${j.token}`);
  }

  return (
    <main className="shop">
      <h1>{board.name}</h1>
      <p className="muted">Antrian meja. Ambil nomor dari ponsel, lalu pantau giliran Anda di sini.</p>
      <section className="rcpt-paper" style={{ margin: '12px 0' }}>
        <p className="rcpt-muted" style={{ margin: 0 }}>Sedang dipanggil</p>
        <p style={{ textAlign: 'center', fontSize: 34, fontWeight: 700, margin: '6px 0' }}>{board.calling.length > 0 ? board.calling.map((c) => c.label).join(' · ') : '–'}</p>
        <p className="rcpt-muted">{board.waiting} rombongan menunggu{board.waiting > 0 ? ` · perkiraan ${board.estimateMin} menit untuk nomor baru` : ''}</p>
      </section>
      <form className="shop-form" onSubmit={submit}>
        <label>Jumlah tamu<input type="number" min={1} max={20} value={form.partySize} onChange={(e) => setForm({ ...form, partySize: e.target.value })} required /></label>
        <label>Nama (opsional)<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} minLength={2} maxLength={40} autoComplete="name" /></label>
        <label>Nomor HP (opsional)<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" autoComplete="tel" minLength={8} maxLength={20} /></label>
        <div className="shop-hp" aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} /></label></div>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Mengambil…' : 'Ambil nomor antrian'}</button>
        <p className="muted small">Nomor HP hanya dipakai kasir bila perlu menghubungi Anda. Satu nomor HP hanya bisa punya satu tiket aktif.</p>
      </form>
    </main>
  );
}

const TITLE = { WAITING: 'Menunggu giliran', CALLED: 'Giliran Anda!', SEATED: 'Silakan menikmati', NO_SHOW: 'Tiket hangus', CANCELED: 'Tiket dibatalkan', EXPIRED: 'Tiket kedaluwarsa' } as const;

/** Status satu tiket; diperbarui sendiri selama masih aktif. */
export function TicketView({ slug, token, t }: { slug: string; token: string; t: PublicTicket }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useRefresh(5_000, t.status === 'WAITING' || t.status === 'CALLED');
  return (
    <main className="rcpt">
      <section className="rcpt-paper" aria-label="Tiket antrian">
        <header>
          <h1>{t.outletName}</h1>
          <p className="rcpt-muted">Nomor antrian Anda</p>
          <p style={{ textAlign: 'center', fontSize: 52, fontWeight: 800, margin: '4px 0' }}>{t.label}</p>
          <p className="rcpt-muted">{t.partySize} orang</p>
        </header>
        <p className={`rcpt-banner ${t.status === 'CALLED' ? '' : t.status === 'WAITING' ? 'warn' : t.status === 'SEATED' ? '' : 'void'}`} role="status">
          <b>{TITLE[t.status]}</b>
          {t.status === 'WAITING' && <><br />{t.ahead === 0 ? 'Anda yang berikutnya.' : `${t.ahead} rombongan di depan Anda · perkiraan ${t.estimateMin} menit.`} Halaman ini diperbarui otomatis; harap tetap dekat.</>}
          {t.status === 'CALLED' && <><br />Silakan menuju kasir/pintu masuk{t.callCount > 1 ? ` (dipanggil ${t.callCount}×)` : ''}. Tiket hangus bila tidak datang.</>}
          {t.status === 'SEATED' && <><br />{t.tableNo ? `Meja ${t.tableNo}.` : ''}</>}
          {(t.status === 'NO_SHOW' || t.status === 'EXPIRED' || t.status === 'CANCELED') && <><br />Ambil nomor baru bila masih ingin menunggu.</>}
        </p>
        {(t.status === 'WAITING' || t.status === 'CALLED') && (
          <p style={{ textAlign: 'center' }}>
            <button className="secondary" disabled={busy} onClick={async () => {
              if (!window.confirm('Batalkan tiket antrian ini?')) return;
              setBusy(true); setError(null);
              const res = await fetch(`/api/antri/cancel/${token}`, { method: 'POST' }).catch(() => null);
              setBusy(false);
              if (!res?.ok) return setError('Gagal membatalkan.');
              router.refresh();
            }}>Batalkan tiket</button>
          </p>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <p style={{ textAlign: 'center' }}><a href={`/antri/${slug}`}>Kembali ke papan antrian</a></p>
      </section>
    </main>
  );
}

/** Layar untuk TV di outlet: nomor yang dipanggil besar-besar. */
export function QueueDisplay({ board }: { board: PublicQueue }) {
  useRefresh(4_000);
  return (
    <main className="shop" style={{ maxWidth: 900, textAlign: 'center' }}>
      <h1 style={{ fontSize: 32 }}>{board.name}</h1>
      <p className="muted" style={{ fontSize: 22 }}>Sedang dipanggil</p>
      <p style={{ fontSize: 110, fontWeight: 800, lineHeight: 1.1, margin: '8px 0' }}>{board.calling.length > 0 ? board.calling[0]!.label : '–'}</p>
      {board.calling.length > 1 && <p style={{ fontSize: 40, margin: 0 }}>{board.calling.slice(1).map((c) => c.label).join('  ·  ')}</p>}
      <p className="muted" style={{ fontSize: 24, marginTop: 28 }}>{board.waiting} rombongan menunggu</p>
    </main>
  );
}
