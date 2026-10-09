'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FirmwareRelease } from '@/lib/api';
import { manage } from '@/lib/manage';

const when = (iso: string) => new Date(iso).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Daftar rilis firmware dan penarikannya. Unggah dilakukan dari komputer yang memegang kunci rilis (tools/release.mts), bukan dari peramban. */
export function FirmwareManager({ releases }: { releases: FirmwareRelease[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function revoke(r: FirmwareRelease) {
    const reason = window.prompt(`Alasan menarik ${r.board}/${r.channel} v${r.version} (build ${r.build}):`);
    if (!reason) return;
    setBusy(true);
    setError(null);
    const res = await manage(`/v1/admin/firmware/${r.id}/revoke`, { reason });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    router.refresh();
  }
  return (
    <>
      <section className="panel">
        <h2>Rilis</h2>
        <table className="table">
          <thead><tr><th>Papan / kanal</th><th>Versi</th><th className="num">Build</th><th className="num">Ukuran</th><th>SHA-256</th><th>Diunggah</th><th /></tr></thead>
          <tbody>
            {releases.map((r) => (
              <tr key={r.id} className={r.revokedAt ? 'off' : ''}>
                <td data-label="Papan / kanal">{r.board} / {r.channel}</td>
                <td data-label="Versi">{r.version}{r.notes && <div className="muted small">{r.notes}</div>}</td>
                <td data-label="Build" className="num">{r.build}</td>
                <td data-label="Ukuran" className="num">{(r.size / 1024).toFixed(0)} KB</td>
                <td data-label="SHA-256" className="mono small">{r.sha256.slice(0, 12)}…</td>
                <td data-label="Diunggah">{when(r.createdAt)}<div className="muted small">oleh {r.createdBy}</div></td>
                <td>{r.revokedAt ? <span className="muted small">Ditarik: {r.revokedReason}</span> : <button type="button" className="secondary" disabled={busy} onClick={() => void revoke(r)}>Tarik</button>}</td>
              </tr>
            ))}
            {releases.length === 0 && <tr><td colSpan={7} className="muted">Belum ada rilis. Sensor melewati pembaruan sampai ada rilis.</td></tr>}
          </tbody>
        </table>
        {error && <p className="error" role="alert">{error}</p>}
      </section>
      <section className="panel">
        <h2>Menerbitkan rilis baru</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Dari komputer Anda (kunci rilis privat tidak pernah ada di server atau peramban):</p>
        <pre className="mono small" style={{ overflowX: 'auto' }}>{`pio run -e esp32c3        # naikkan FW_BUILD dan FW_VERSION di app/config.h dulu
npx tsx firmware/sensor-node/tools/release.mts sign .pio/build/esp32c3/firmware.bin \\
  --key release-private.pem --board esp32c3 --channel stable --version 1.2.0 --build 3
npx tsx firmware/sensor-node/tools/release.mts publish .pio/build/esp32c3/firmware.bin \\
  --server https://anatta-pos.dolanyu.com --token adm_... --code 123456`}</pre>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Disarankan menerbitkan ke kanal <span className="mono">beta</span> dulu (sensor uji dengan <span className="mono">FW_CHANNEL &quot;beta&quot;</span>), lalu ke <span className="mono">stable</span>. Menarik rilis menghentikan penawarannya; sensor yang sudah memasangnya tetap berjalan (tidak ada pembatalan paksa), dan build berikutnya harus lebih besar.
        </p>
      </section>
    </>
  );
}
