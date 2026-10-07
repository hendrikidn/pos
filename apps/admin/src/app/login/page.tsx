'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function LoginPage() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <h1>Anatta POS <span className="admin-tag">ADMIN</span></h1>
      <p className="sub">Konsol admin platform. Masuk dengan token admin (diawali <span className="mono">adm_</span>).</p>
      <form className="panel" onSubmit={submit}>
        <label htmlFor="token" className="sub" style={{ display: 'block', margin: '0 0 6px' }}>Token admin</label>
        <input id="token" type="password" autoComplete="off" placeholder="adm_…" value={token} onChange={(e) => setToken(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <p style={{ margin: '14px 0 0' }}>
          <button type="submit" disabled={busy || !token.trim()}>{busy ? 'Memeriksa…' : 'Masuk'}</button>
        </p>
      </form>
    </main>
  );
}
