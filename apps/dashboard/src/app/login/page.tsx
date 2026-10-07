'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function LoginPage() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suspended, setSuspended] = useState(false);
  useEffect(() => setSuspended(new URLSearchParams(window.location.search).get('s') === '1'), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token.trim() }),
    }).catch(() => null);
    setBusy(false);
    if (!res) return setError('Tidak dapat menghubungi server.');
    if (!res.ok) return setError(((await res.json().catch(() => ({}))) as { message?: string }).message ?? 'Login gagal.');
    router.push('/');
    router.refresh();
  }

  return (
    <main className="login">
      <h1>POS Guard</h1>
      <p className="sub">Masuk dengan token pengguna dari administrator.</p>
      {suspended && <p className="notice" role="alert">Akun tenant ini sedang ditangguhkan. Hubungi administrator.</p>}
      <form className="panel" onSubmit={submit}>
        <label htmlFor="token" className="sub" style={{ display: 'block', margin: '0 0 6px' }}>Token pengguna</label>
        <input id="token" type="password" autoComplete="off" placeholder="api_…" value={token} onChange={(e) => setToken(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <p style={{ margin: '14px 0 0' }}>
          <button type="submit" disabled={busy || !token.trim()}>{busy ? 'Memeriksa…' : 'Masuk'}</button>
        </p>
      </form>
    </main>
  );
}
