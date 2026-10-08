'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { manage } from '@/lib/manage';
import { wibClock } from '@/lib/format';

export interface QueueDay {
  day: string;
  stats: { total: number; seated: number; noShow: number; canceled: number; waiting: number; avgWaitMin: number | null; jumps: number };
  tickets: {
    id: number; label: string; partySize: number; name: string | null; phone: string | null; source: 'SELF' | 'STAFF'; status: string; createdAt: number; calledAt: number | null; callCount: number;
    calledBy: string | null; jumpReason: string | null; jumpNote: string | null; jumpedOver: string[] | null; seatedAt: number | null; seatedBy: string | null; tableNo: string | null; closedReason: string | null;
  }[];
}
const STATUS: Record<string, string> = { WAITING: 'Menunggu', CALLED: 'Dipanggil', SEATED: 'Duduk', NO_SHOW: 'Tidak datang', CANCELED: 'Dibatalkan', EXPIRED: 'Kedaluwarsa' };
const JUMP: Record<string, string> = { TABLE_SIZE: 'meja cocok', PRIORITY: 'prioritas', OTHER: 'lainnya' };

export function QueueManager({ outletId, isOwner, settings, data, origin }: { outletId: string; isOwner: boolean; settings: { slug: string | null; enabled: boolean }; data: QueueDay; origin: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const base = settings.slug ? `${origin}/antri/${settings.slug}` : null;
  const s = data.stats;

  async function toggle(enabled: boolean) {
    setBusy(true); setError(null); setNotice(null);
    const r = await manage('PUT', `/v1/outlets/${outletId}/queue-settings`, { enabled });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setNotice(enabled ? 'Antrian diaktifkan.' : 'Antrian dimatikan.');
    router.refresh();
  }

  return (
    <>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="ok-note" role="status">{notice}</p>}
      <section className="panel">
        <h2>Antrian online</h2>
        {settings.enabled && base ? (
          <ul className="plain">
            <li>Tiket pelanggan (QR di pintu): <a href={base} target="_blank" rel="noreferrer">{base}</a></li>
            <li>Layar TV: <a href={`${base}/layar`} target="_blank" rel="noreferrer">{base}/layar</a></li>
          </ul>
        ) : <p className="muted">{settings.slug ? 'Antrian online belum aktif.' : 'Atur alamat toko dulu di halaman Toko Web (alamat itu dipakai antrian juga).'}</p>}
        {isOwner ? (
          <p className="actions">
            {settings.enabled ? <button className="secondary" disabled={busy} onClick={() => void toggle(false)}>Matikan antrian</button> : <button disabled={busy || !settings.slug} onClick={() => void toggle(true)}>Aktifkan antrian</button>}
          </p>
        ) : <p className="muted small">Hanya owner yang mengaktifkan antrian.</p>}
        <p className="muted small" style={{ marginBottom: 0 }}>Kasir memanggil dan mendudukkan tamu dari tombol &quot;Antrian&quot; di aplikasi kasir. Memanggil tiket yang bukan giliran pertama wajib beralasan; selain &quot;meja cocok&quot; (diperiksa mesin) menjadi temuan di Insiden, begitu pula tamu yang didudukkan tanpa order kasir yang sah.</p>
      </section>
      <section className="panel">
        <h2>Hari ini · {data.day}</h2>
        <p>{s.total} tiket · {s.seated} duduk · {s.noShow} tidak datang · {s.canceled} batal · {s.waiting} aktif{s.avgWaitMin !== null ? ` · rata-rata tunggu ${s.avgWaitMin} menit` : ''}{s.jumps > 0 ? ` · ` : ''}{s.jumps > 0 && <b>{s.jumps} kali melewati antrian</b>}</p>
        {data.tickets.length === 0 ? <p className="muted">Belum ada tiket hari ini.</p> : (
          <table className="table">
            <thead><tr><th>Nomor</th><th className="num">Orang</th><th>Tamu</th><th>Masuk</th><th>Status</th><th>Catatan</th></tr></thead>
            <tbody>
              {data.tickets.map((t) => (
                <tr key={t.id} className={t.status === 'NO_SHOW' || t.status === 'CANCELED' || t.status === 'EXPIRED' ? 'off' : ''}>
                  <td data-label="Nomor"><b>{t.label}</b><div className="muted small">{t.source === 'SELF' ? 'online' : 'kasir'}</div></td>
                  <td data-label="Orang" className="num">{t.partySize}</td>
                  <td data-label="Tamu">{t.name ?? '–'}<div className="muted small">{t.phone ?? ''}</div></td>
                  <td data-label="Masuk">{wibClock(t.createdAt)}{t.calledAt ? <div className="muted small">dipanggil {wibClock(t.calledAt)}{t.callCount > 1 ? ` (${t.callCount}×)` : ''}</div> : null}</td>
                  <td data-label="Status">{STATUS[t.status] ?? t.status}{t.tableNo ? ` · meja ${t.tableNo}` : ''}{t.seatedBy ? <div className="muted small">oleh {t.seatedBy}</div> : null}</td>
                  <td data-label="Catatan" className="small">
                    {t.jumpReason && <span className={t.jumpReason === 'TABLE_SIZE' ? '' : 'delta neg'}>melewati {t.jumpedOver?.join(', ')} ({JUMP[t.jumpReason]}{t.jumpNote ? `: ${t.jumpNote}` : ''}) oleh {t.calledBy}</span>}
                    {t.closedReason && <span className="muted">{t.closedReason}</span>}
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
