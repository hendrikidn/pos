'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

type Step = 'email' | 'code' | 'token';
const RESEND_SECONDS = 60;

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; message?: string }> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  if (!res) return { ok: false, status: 0, message: 'Tidak dapat menghubungi server.' };
  if (res.ok) return { ok: true, status: res.status };
  return { ok: false, status: res.status, message: ((await res.json().catch(() => ({}))) as { message?: string }).message ?? 'Permintaan gagal.' };
}

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [suspended, setSuspended] = useState(false);
  const [wait, setWait] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => setSuspended(new URLSearchParams(window.location.search).get('s') === '1'), []);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait(wait - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  useEffect(() => { if (step === 'code') codeRef.current?.focus(); }, [step]);

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    const r = await post('/api/otp/request', { email: email.trim() });
    setBusy(false);
    if (!r.ok) return setError(r.message ?? 'Gagal mengirim kode.');
    setStep('code');
    setCode('');
    setWait(RESEND_SECONDS);
    setInfo(`Jika ${email.trim()} terdaftar, kode 6 digit sudah dikirim. Berlaku 10 menit.`);
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await post('/api/otp/verify', { email: email.trim(), code: code.trim() });
    setBusy(false);
    if (!r.ok) return setError(r.message ?? 'Kode salah atau sudah kedaluwarsa.');
    router.push('/');
    router.refresh();
  }

  async function withToken(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await post('/api/login', { token: token.trim() });
    setBusy(false);
    if (!r.ok) return setError(r.message ?? 'Login gagal.');
    router.push('/');
    router.refresh();
  }

  return (
    <main className="login">
      <h1>POS Guard</h1>
      {suspended && <p className="notice" role="alert">Akun tenant ini sedang ditangguhkan. Hubungi administrator.</p>}

      {step === 'email' && (
        <>
          <p className="sub">Masuk dengan email Anda. Kami kirim kode 6 digit.</p>
          <form className="panel" onSubmit={sendCode}>
            <label htmlFor="email" className="sub" style={{ display: 'block', margin: '0 0 6px' }}>Email</label>
            <input id="email" type="email" inputMode="email" autoComplete="email" placeholder="nama@usaha.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
            {error && <p className="error" role="alert">{error}</p>}
            <p style={{ margin: '14px 0 0' }}><button type="submit" disabled={busy || !email.trim()}>{busy ? 'Mengirim…' : 'Kirim kode'}</button></p>
          </form>
          <p className="sub"><a href="#" onClick={(e) => { e.preventDefault(); setStep('token'); setError(null); }}>Masuk dengan token</a></p>
        </>
      )}

      {step === 'code' && (
        <>
          <p className="sub">Masukkan kode dari email.</p>
          <form className="panel" onSubmit={verify}>
            {info && <p className="sub" role="status" style={{ marginTop: 0 }}>{info}</p>}
            <label htmlFor="code" className="sub" style={{ display: 'block', margin: '0 0 6px' }}>Kode 6 digit</label>
            <input
              id="code" ref={codeRef} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} placeholder="123456"
              value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, ''))} required
              style={{ fontSize: 24, letterSpacing: 6, textAlign: 'center' }}
            />
            {error && <p className="error" role="alert">{error}</p>}
            <p style={{ margin: '14px 0 0' }}><button type="submit" disabled={busy || code.replace(/\s/g, '').length !== 6}>{busy ? 'Memeriksa…' : 'Masuk'}</button></p>
          </form>
          <p className="sub">
            <button type="button" className="secondary" disabled={busy || wait > 0} onClick={() => void sendCode()}>
              {wait > 0 ? `Kirim ulang kode (${wait} dtk)` : 'Kirim ulang kode'}
            </button>{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); setStep('email'); setError(null); setInfo(null); }}>Ganti email</a>
          </p>
        </>
      )}

      {step === 'token' && (
        <>
          <p className="sub">Jalur cadangan: masuk dengan token pengguna dari administrator.</p>
          <form className="panel" onSubmit={withToken}>
            <label htmlFor="token" className="sub" style={{ display: 'block', margin: '0 0 6px' }}>Token pengguna</label>
            <input id="token" type="password" autoComplete="off" placeholder="api_…" value={token} onChange={(e) => setToken(e.target.value)} />
            {error && <p className="error" role="alert">{error}</p>}
            <p style={{ margin: '14px 0 0' }}><button type="submit" disabled={busy || !token.trim()}>{busy ? 'Memeriksa…' : 'Masuk'}</button></p>
          </form>
          <p className="sub"><a href="#" onClick={(e) => { e.preventDefault(); setStep('email'); setError(null); }}>Masuk dengan email</a></p>
        </>
      )}
    </main>
  );
}
