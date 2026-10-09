'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { SessionRow } from '@/lib/api';
import { manage } from '@/lib/manage';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–');

/** Sesi login yang sedang aktif untuk akun ini: peramban/perangkat mana yang masuk, dari alamat apa, kapan terakhir dipakai; bisa dicabut satu per satu. */
export function SessionsPanel({ sessions }: { sessions: SessionRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(f: () => ReturnType<typeof manage>) {
    setBusy(true);
    setError(null);
    const r = await f();
    setBusy(false);
    if (!r.ok) return setError(r.message);
    router.refresh();
  }

  return (
    <section className="panel">
      <h2>Sesi yang sedang masuk</h2>
      <p className="muted small" style={{ marginTop: 0 }}>Jika ada yang tidak Anda kenali, cabut sesinya lalu ganti password.</p>
      <table className="table">
        <thead><tr><th>Mulai</th><th>Terakhir dipakai</th><th>Alamat</th><th>Peramban</th><th /></tr></thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <td data-label="Mulai">{when(s.createdAt)}{s.current && <b> · sesi ini</b>}</td>
              <td data-label="Terakhir dipakai">{when(s.lastUsedAt)}</td>
              <td data-label="Alamat" className="mono">{s.ip ?? '–'}</td>
              <td data-label="Peramban" className="small">{(s.userAgent ?? '–').slice(0, 60)}</td>
              <td data-label="">{!s.current && <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => manage('DELETE', `/v1/auth/sessions/${s.id}`))}>Cabut</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sessions.length > 1 && <p style={{ marginBottom: 0 }}><button type="button" className="secondary" disabled={busy} onClick={() => void run(() => manage('POST', '/v1/auth/sessions/revoke-others'))}>Keluar dari semua perangkat lain</button></p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
