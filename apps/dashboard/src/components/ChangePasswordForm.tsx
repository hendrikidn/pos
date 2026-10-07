'use client';

import { useState } from 'react';

export function ChangePasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const type = show ? 'text' : 'password';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next !== confirm) return setError('Konfirmasi password tidak sama.');
    setBusy(true);
    const res = await fetch('/api/account/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current, password: next }) }).catch(() => null);
    setBusy(false);
    if (!res) return setError('Tidak dapat menghubungi server.');
    if (!res.ok) return setError(((await res.json().catch(() => ({}))) as { message?: string }).message ?? 'Gagal mengganti password.');
    setDone(true);
    setCurrent('');
    setNext('');
    setConfirm('');
  }

  return (
    <form className="panel" onSubmit={submit} style={{ maxWidth: 460 }}>
      <h2>Ganti password</h2>
      <label className="sub" htmlFor="cur" style={{ display: 'block', margin: '0 0 6px' }}>Password saat ini</label>
      <input id="cur" type={type} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      <label className="sub" htmlFor="new" style={{ display: 'block', margin: '14px 0 6px' }}>Password baru (minimal 10 karakter; kalimat panjang boleh)</label>
      <input id="new" type={type} autoComplete="new-password" minLength={10} maxLength={128} value={next} onChange={(e) => setNext(e.target.value)} required />
      <label className="sub" htmlFor="conf" style={{ display: 'block', margin: '14px 0 6px' }}>Ulangi password baru</label>
      <input id="conf" type={type} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      <label className="sub" style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '12px 0 0' }}>
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} style={{ width: 'auto' }} /> Tampilkan password
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      {done && <p className="ok-note" role="status">Password diganti. Sesi di perangkat lain diputus; sesi ini tetap aktif.</p>}
      <p style={{ margin: '14px 0 0' }}><button type="submit" disabled={busy || !current || !next || !confirm}>{busy ? 'Menyimpan…' : 'Ganti password'}</button></p>
    </form>
  );
}
