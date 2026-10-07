'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { OutletSettings } from '@/lib/api';
import { wibDateTime } from '@/lib/format';
import { manage } from '@/lib/manage';

/**
 * Saklar mode shadow per outlet. Menonaktifkan: insiden berikutnya langsung dikirim. Mengaktifkan: shadow berlaku
 * seketika dan hitungan hari dimulai dari sekarang (berguna untuk menguji kalibrasi atau notifikasi).
 */
export function ShadowControl({ s }: { s: OutletSettings }) {
  const router = useRouter();
  const st = s.shadow;
  const [days, setDays] = useState(String(st.days > 0 ? st.days : 14));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const n = Number(days);
  const valid = Number.isInteger(n) && n >= 1 && n <= 60;

  async function apply(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setMsg(null);
    const r = await manage('PUT', `/v1/outlets/${s.id}/settings`, body);
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.message });
    setMsg({ ok: true, text: done });
    router.refresh();
  }

  const status = !st.enabled
    ? 'Nonaktif: insiden langsung dikirim dan tampil di antrean review.'
    : st.pending
      ? `Aktif (${st.days} hari). Hitungan dimulai saat ada order, pembayaran, atau sesi sensor pertama.`
      : st.active
        ? `Aktif: hari ke-${st.day} dari ${st.days}, berakhir ${wibDateTime(st.untilMs!)}.`
        : `Sudah selesai pada ${wibDateTime(st.untilMs!)}. Insiden baru langsung dikirim.`;

  return (
    <section className="panel" aria-labelledby={`shadow-${s.id}`}>
      <h2 id={`shadow-${s.id}`}>Mode shadow · {s.name}</h2>
      <p style={{ marginTop: 0 }}>
        <span className={`badge ${st.active ? 'badge-MEDIUM' : 'badge-ok'}`}>{st.active ? 'Shadow aktif' : st.enabled ? 'Shadow selesai' : 'Shadow nonaktif'}</span>{' '}
        {status}
      </p>
      <p className="muted small">
        Selama shadow, insiden tetap dihitung tetapi <b>tidak dikirim</b> dan tidak masuk antrean review. Hasilnya dikumpulkan di halaman Ringkasan shadow
        untuk menyetel sensor dan ambang sebelum notifikasi dinyalakan. Insiden yang sudah tercatat selama shadow tidak berubah menjadi live saat shadow dinonaktifkan.
      </p>

      <div className="form-grid">
        <label>Lama shadow (hari, 1–60)
          <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />
        </label>
        <div className="form-actions" style={{ gap: 8, flexWrap: 'wrap' }}>
          {st.active && (
            <button type="button" className="secondary" disabled={busy || !valid || n === st.days} onClick={() => void apply({ shadowDays: n }, `Lama shadow diubah menjadi ${n} hari.`)}>
              Simpan lama
            </button>
          )}
          {st.active ? (
            <button type="button" className="secondary" disabled={busy} onClick={() => void apply({ shadowDays: 0 }, 'Mode shadow dinonaktifkan: insiden berikutnya langsung dikirim.')}>
              Nonaktifkan sekarang
            </button>
          ) : (
            <button type="button" disabled={busy || !valid} onClick={() => void apply({ shadowDays: n, shadowRestart: true }, `Mode shadow aktif ${n} hari, dihitung dari sekarang.`)}>
              {st.enabled ? 'Aktifkan lagi' : 'Aktifkan mode shadow'}
            </button>
          )}
        </div>
      </div>
      {msg && <p className={msg.ok ? 'ok-note' : 'error'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    </section>
  );
}
