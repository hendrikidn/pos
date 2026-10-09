'use client';

import qrcode from 'qrcode-generator';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AdminSecurityStatus } from '@/lib/api';
import { manage } from '@/lib/manage';
import { CopyButton } from './CopyButton';

const when = (iso: string) => new Date(iso).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function Qr({ value }: { value: string }) {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const box = n + quiet * 2;
  return (
    <svg role="img" aria-label="Kode QR untuk aplikasi autentikator" width={200} height={200} viewBox={`0 0 ${box} ${box}`} shapeRendering="crispEdges">
      <rect width={box} height={box} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

/** Mengaktifkan atau mematikan verifikasi 2 langkah (TOTP) dan mengelola sesi konsol admin. */
export function SecurityManager({ status }: { status: AdminSecurityStatus }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');

  async function run<T>(f: () => ReturnType<typeof manage<T>>, after?: (d: T) => void) {
    setBusy(true);
    setError(null);
    const r = await f();
    setBusy(false);
    if (!r.ok) return setError(r.message);
    after?.(r.data);
    router.refresh();
  }

  return (
    <>
      <section className="panel">
        <h2>Verifikasi 2 langkah (TOTP)</h2>
        {!status.twoFactor && !setup && !codes && (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>Belum aktif. Dengan 2FA, token admin saja tidak cukup untuk masuk: pencuri token tetap butuh kode dari ponsel Anda. Gunakan Google Authenticator, Authy, 1Password, atau sejenisnya.</p>
            <button type="button" disabled={busy} onClick={() => void run(() => manage<{ secret: string; otpauthUrl: string }>('/v1/admin/auth/2fa/setup'), (d) => { setSetup(d); setCode(''); })}>Mulai aktifkan</button>
          </>
        )}
        {setup && !codes && (
          <>
            <p style={{ marginTop: 0 }}>1. Pindai kode ini dengan aplikasi autentikator (atau masukkan rahasia secara manual):</p>
            <Qr value={setup.otpauthUrl} />
            <p><span className="mono" style={{ wordBreak: 'break-all' }}>{setup.secret}</span> <CopyButton text={setup.secret} /></p>
            <p>2. Masukkan kode 6 angka yang tampil di aplikasi untuk membuktikan:</p>
            <div className="row">
              <input inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Kode 6 angka" />
              <button type="button" disabled={busy || code.trim().length < 6} onClick={() => void run(() => manage<{ recoveryCodes: string[] }>('/v1/admin/auth/2fa/enable', { code }), (d) => { setCodes(d.recoveryCodes); setSetup(null); setCode(''); })}>Aktifkan</button>
            </div>
          </>
        )}
        {codes && (
          <div className="panel urgent" role="status">
            <p style={{ marginTop: 0 }}><b>2FA aktif.</b> Simpan kode pemulihan ini di tempat aman (pengelola sandi). Tiap kode hanya bisa dipakai sekali dan <b>tidak akan ditampilkan lagi</b>; gunakan bila ponsel hilang.</p>
            <p className="mono">{codes.map((c) => <span key={c} style={{ display: 'block' }}>{c}</span>)}</p>
            <CopyButton text={codes.join('\n')} label="Salin semua" />
            <button type="button" className="secondary" onClick={() => setCodes(null)}>Sudah saya simpan</button>
          </div>
        )}
        {status.twoFactor && !codes && (
          <>
            <p style={{ marginTop: 0 }}><b>Aktif.</b> Sisa kode pemulihan: {status.recoveryCodesLeft} dari 8. Token admin mentah tidak lagi diterima API; masuk hanya lewat halaman login dengan kode.</p>
            <div className="row">
              <input inputMode="numeric" autoComplete="one-time-code" placeholder="Kode untuk mematikan" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Kode untuk mematikan 2FA" />
              <button type="button" className="secondary" disabled={busy || !code.trim()} onClick={() => void run(() => manage('/v1/admin/auth/2fa/disable', { code }), () => setCode(''))}>Matikan 2FA</button>
            </div>
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      <section className="panel">
        <h2>Sesi yang sedang masuk</h2>
        <table className="table">
          <thead><tr><th>Mulai</th><th>Alamat</th><th>Peramban</th><th>Berakhir</th><th /></tr></thead>
          <tbody>
            {status.sessions.map((s) => (
              <tr key={s.id}>
                <td data-label="Mulai">{when(s.createdAt)}{s.current && <b> · sesi ini</b>}</td>
                <td data-label="Alamat" className="mono">{s.ip ?? '–'}</td>
                <td data-label="Peramban" className="small">{(s.userAgent ?? '–').slice(0, 70)}</td>
                <td data-label="Berakhir">{when(s.expiresAt)}</td>
                <td data-label="">{!s.current && <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => manage(`/v1/admin/auth/sessions/${s.id}`, undefined, 'DELETE'))}>Cabut</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {status.sessions.length > 1 && <p><button type="button" className="secondary" disabled={busy} onClick={() => void run(() => manage('/v1/admin/auth/sessions/revoke-others'))}>Keluar dari semua sesi lain</button></p>}
      </section>
    </>
  );
}
