'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { DeviceRow, Outlet, PendingPairing } from '@/lib/api';
import { ago, wibClock } from '@/lib/format';
import { manage } from '@/lib/manage';
import { CopyButton } from './CopyButton';

const KIND_LABEL = { sensor: 'Sensor', terminal: 'Terminal POS', kds: 'Layar dapur' } as const;
/** Sensor mengirim detak tiap 30 detik; lewat 5 menit tanpa kabar dianggap offline. */
const ONLINE_MS = 5 * 60_000;

interface Issued {
  code: string;
  deviceId: string;
  kind: DeviceRow['kind'];
  expiresAt: string;
}

export function DeviceManager({
  outlets, devices, pending, role, now,
}: { outlets: Outlet[]; devices: DeviceRow[]; pending: PendingPairing[]; role: string; now: number }) {
  const router = useRouter();
  const [form, setForm] = useState({ outletId: outlets[0]?.id ?? '', kind: 'sensor', deviceId: '', terminalId: '' });
  const [issued, setIssued] = useState<Issued | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>, okMsg?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return undefined;
    }
    if (okMsg) setNotice(okMsg);
    router.refresh();
    return r.data;
  }

  const status = (d: DeviceRow) => {
    if (d.revoked_at) return <span className="badge badge-CRITICAL">Dicabut</span>;
    if (d.last_seen_ms === null) return <span className="muted">Belum pernah terhubung</span>;
    const online = now - d.last_seen_ms < ONLINE_MS;
    return (
      <>
        <span className={online ? 'badge badge-ok' : 'badge badge-MEDIUM'}>{online ? 'Online' : 'Offline'}</span>{' '}
        <span className="muted small">{ago(d.last_seen_ms, now)}</span>
      </>
    );
  };

  return (
    <>
      <section className="panel">
        <h2>Tambah perangkat</h2>
        <p className="muted small">
          Buat kode pairing, lalu masukkan kode itu di perangkat saat pemasangan. Token dibuat otomatis oleh server dan tidak perlu disalin atau ditanam di firmware.
        </p>
        <form
          className="form-grid"
          onSubmit={async (e) => {
            e.preventDefault();
            setIssued(null);
            const body = {
              outletId: form.outletId,
              kind: form.kind,
              ...(form.deviceId ? { deviceId: form.deviceId } : {}),
              ...(form.kind === 'sensor' && form.terminalId ? { terminalId: form.terminalId } : {}),
            };
            const data = (await run(() => manage('POST', '/v1/devices/pairing', body))) as Issued | undefined;
            if (data) {
              setIssued(data);
              setForm({ ...form, deviceId: '', terminalId: '' });
            }
          }}
        >
          <label>Outlet
            <select value={form.outletId} onChange={(e) => setForm({ ...form, outletId: e.target.value })} required>
              {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label>Jenis
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="sensor">Sensor kehadiran</option>
              <option value="terminal">Terminal POS</option>
              <option value="kds">Layar dapur</option>
            </select>
          </label>
          <label>ID perangkat (opsional)
            <input value={form.deviceId} onChange={(e) => setForm({ ...form, deviceId: e.target.value.toLowerCase() })} maxLength={40} placeholder="otomatis bila kosong" />
          </label>
          {form.kind === 'sensor' && (
            <label>Terminal yang disangga (opsional)
              <input value={form.terminalId} onChange={(e) => setForm({ ...form, terminalId: e.target.value.toLowerCase() })} maxLength={40} placeholder="mis. pos-1" />
            </label>
          )}
          <div className="form-actions"><button type="submit" disabled={busy || !form.outletId}>Buat kode pairing</button></div>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="ok-note" role="status">{notice}</p>}

        {issued && (
          <div className="panel urgent" role="status" aria-live="polite">
            <p className="muted small">Kode untuk {KIND_LABEL[issued.kind]} <span className="mono">{issued.deviceId}</span></p>
            <p className="mono" style={{ fontSize: 32, fontWeight: 700, letterSpacing: 4, margin: '6px 0' }}>{issued.code}</p>
            <p className="muted small">
              Berlaku sampai {wibClock(Date.parse(issued.expiresAt))} WIB dan hanya bisa dipakai sekali. Kode ini tidak akan ditampilkan lagi; bila hilang, buat kode baru.
            </p>
            <CopyButton text={issued.code} label="Salin kode" />
          </div>
        )}
      </section>

      {pending.length > 0 && (
        <section className="panel">
          <h2>Menunggu dipasang</h2>
          <table className="table">
            <thead><tr><th>Perangkat</th><th>Jenis</th><th>Outlet</th><th>Berlaku sampai</th><th /></tr></thead>
            <tbody>
              {pending.map((p) => (
                <tr key={p.device_id}>
                  <td className="mono">{p.device_id}{p.terminal_id ? ` → ${p.terminal_id}` : ''}</td>
                  <td>{KIND_LABEL[p.kind]}</td>
                  <td>{outlets.find((o) => o.id === p.outlet_id)?.name ?? p.outlet_id}</td>
                  <td>{wibClock(Date.parse(p.expires_at))} WIB</td>
                  <td className="row-actions">
                    <button className="secondary" disabled={busy} onClick={() => void run(() => manage('DELETE', `/v1/devices/pairing/${p.device_id}`), `Kode untuk ${p.device_id} dibatalkan.`)}>
                      Batalkan
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="panel">
        <h2>Perangkat terpasang</h2>
        <table className="table">
          <thead><tr><th>ID</th><th>Jenis</th><th>Outlet</th><th>Terminal</th><th>Status</th><th /></tr></thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} className={d.revoked_at ? 'off' : ''}>
                <td className="mono">{d.id}</td>
                <td>{KIND_LABEL[d.kind]}</td>
                <td>{outlets.find((o) => o.id === d.outlet_id)?.name ?? d.outlet_id}</td>
                <td className="mono">{d.terminal_id ?? '–'}</td>
                <td>{status(d)}</td>
                <td className="row-actions">
                  {role === 'OWNER' && !d.revoked_at && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Cabut ${d.id}? Perangkat ini langsung tidak bisa mengirim data. Untuk memakainya lagi, buat kode pairing baru dengan ID lain.`)) {
                          void run(() => manage('POST', `/v1/devices/${d.id}/revoke`, {}), `${d.id} dicabut.`);
                        }
                      }}
                    >
                      Cabut
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {devices.length === 0 && <tr><td colSpan={6} className="muted">Belum ada perangkat.</td></tr>}
          </tbody>
        </table>
        <p className="muted small">Mencabut perangkat tidak menghapus event yang sudah dikirimnya; riwayat tetap utuh.</p>
      </section>
    </>
  );
}
