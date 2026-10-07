'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

type Mode = 'password' | 'forgot' | 'otp' | 'token';
const RESEND_SECONDS = 60;
const PASSWORD_MIN = 10;

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; message?: string }> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  if (!res) return { ok: false, status: 0, message: 'Tidak dapat menghubungi server.' };
  if (res.ok) return { ok: true, status: res.status };
  return { ok: false, status: res.status, message: ((await res.json().catch(() => ({}))) as { message?: string }).message ?? 'Permintaan gagal.' };
}

const labelStyle = { display: 'block', margin: '0 0 6px' } as const;

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('password');
  const [codeSent, setCodeSent] = useState(false); // langkah 2 untuk 'forgot' dan 'otp'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [suspended, setSuspended] = useState(false);
  const [wait, setWait] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);
  const pwType = showPw ? 'text' : 'password';

  useEffect(() => setSuspended(new URLSearchParams(window.location.search).get('s') === '1'), []);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait(wait - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  useEffect(() => { if (codeSent) codeRef.current?.focus(); }, [codeSent]);

  function go(next: Mode) {
    setMode(next);
    setCodeSent(false);
    setError(null);
    setInfo(null);
    setCode('');
    setPassword('');
    setNewPassword('');
    setConfirm('');
  }
  const link = (label: string, next: Mode) => (
    <a href="#" onClick={(e) => { e.preventDefault(); go(next); }}>{label}</a>
  );
  const done = () => { router.push('/'); router.refresh(); };

  async function passwordLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await post('/api/auth/login', { email: email.trim(), password });
    setBusy(false);
    if (!r.ok) return setError(r.message ?? 'Email atau password salah.');
    done();
  }

  /** Mengirim kode: untuk atur ulang password ('forgot') atau masuk dengan kode ('otp'). */
  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    const r = await post(mode === 'forgot' ? '/api/auth/forgot' : '/api/otp/request', { email: email.trim() });
    setBusy(false);
    if (!r.ok) return setError(r.message ?? 'Gagal mengirim kode.');
    setCodeSent(true);
    setCode('');
    setWait(RESEND_SECONDS);
    setInfo(`Jika ${email.trim()} terdaftar, kode 6 digit sudah dikirim. Berlaku 10 menit.`);
  }

  async function resetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < PASSWORD_MIN) return setError(`Password minimal ${PASSWORD_MIN} karakter.`);
    if (newPassword !== confirm) return setError('Konfirmasi password tidak sama.');
    setBusy(true);
    const r = await post('/api/auth/reset', { email: email.trim(), code: code.trim(), password: newPassword });
    setBusy(false);
    if (!r.ok) return setError(r.message ?? 'Kode salah atau sudah kedaluwarsa.');
    done();
  }

  async function otpLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await post('/api/otp/verify', { email: email.trim(), code: code.trim() });
    setBusy(false);
    if (!r.ok) return setError(r.message ?? 'Kode salah atau sudah kedaluwarsa.');
    done();
  }

  async function tokenLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await post('/api/login', { token: token.trim() });
    setBusy(false);
    if (!r.ok) return setError(r.message ?? 'Login gagal.');
    done();
  }

  const showToggle = (
    <label className="sub" style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '10px 0 0' }}>
      <input type="checkbox" checked={showPw} onChange={(e) => setShowPw(e.target.checked)} style={{ width: 'auto' }} /> Tampilkan password
    </label>
  );
  const codeInput = (
    <>
      <label htmlFor="code" className="sub" style={labelStyle}>Kode 6 digit dari email</label>
      <input
        id="code" ref={codeRef} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} placeholder="123456"
        value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, ''))} required
        style={{ fontSize: 24, letterSpacing: 6, textAlign: 'center' }}
      />
    </>
  );
  const resend = (
    <p className="sub">
      <button type="button" className="secondary" disabled={busy || wait > 0} onClick={() => void sendCode()}>
        {wait > 0 ? `Kirim ulang kode (${wait} dtk)` : 'Kirim ulang kode'}
      </button>{' '}
      <a href="#" onClick={(e) => { e.preventDefault(); setCodeSent(false); setError(null); setInfo(null); }}>Ganti email</a>
    </p>
  );

  return (
    <main className="login">
      <h1>POS Guard</h1>
      {suspended && <p className="notice" role="alert">Akun tenant ini sedang ditangguhkan. Hubungi administrator.</p>}

      {mode === 'password' && (
        <>
          <p className="sub">Masuk dengan email dan password.</p>
          <form className="panel" onSubmit={passwordLogin}>
            <label htmlFor="email" className="sub" style={labelStyle}>Email</label>
            <input id="email" type="email" inputMode="email" autoComplete="username" placeholder="nama@usaha.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <label htmlFor="pw" className="sub" style={{ ...labelStyle, marginTop: 14 }}>Password</label>
            <input id="pw" type={pwType} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            {showToggle}
            {error && <p className="error" role="alert">{error}</p>}
            <p style={{ margin: '14px 0 0' }}><button type="submit" disabled={busy || !email.trim() || !password}>{busy ? 'Memeriksa…' : 'Masuk'}</button></p>
          </form>
          <p className="sub">{link('Lupa password / atur password', 'forgot')}</p>
          <p className="sub muted small">Pengguna baru: pilih &quot;Lupa password / atur password&quot; untuk membuat password pertama kali.</p>
          <p className="sub small">{link('Masuk dengan kode email', 'otp')} · {link('Masuk dengan token', 'token')}</p>
        </>
      )}

      {mode === 'forgot' && !codeSent && (
        <>
          <p className="sub">Atur atau atur ulang password. Kami kirim kode 6 digit ke email Anda.</p>
          <form className="panel" onSubmit={sendCode}>
            <label htmlFor="email" className="sub" style={labelStyle}>Email</label>
            <input id="email" type="email" inputMode="email" autoComplete="username" placeholder="nama@usaha.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
            {error && <p className="error" role="alert">{error}</p>}
            <p style={{ margin: '14px 0 0' }}><button type="submit" disabled={busy || !email.trim()}>{busy ? 'Mengirim…' : 'Kirim kode'}</button></p>
          </form>
          <p className="sub">{link('Kembali ke halaman masuk', 'password')}</p>
        </>
      )}

      {mode === 'forgot' && codeSent && (
        <>
          <p className="sub">Masukkan kode dan password baru.</p>
          <form className="panel" onSubmit={resetPassword}>
            {info && <p className="sub" role="status" style={{ marginTop: 0 }}>{info}</p>}
            {codeInput}
            <label htmlFor="np" className="sub" style={{ ...labelStyle, marginTop: 14 }}>Password baru (minimal {PASSWORD_MIN} karakter; kalimat panjang boleh)</label>
            <input id="np" type={pwType} autoComplete="new-password" minLength={PASSWORD_MIN} maxLength={128} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
            <label htmlFor="cp" className="sub" style={{ ...labelStyle, marginTop: 14 }}>Ulangi password baru</label>
            <input id="cp" type={pwType} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            {showToggle}
            {error && <p className="error" role="alert">{error}</p>}
            <p style={{ margin: '14px 0 0' }}>
              <button type="submit" disabled={busy || code.replace(/\s/g, '').length !== 6 || !newPassword || !confirm}>{busy ? 'Menyimpan…' : 'Simpan password & masuk'}</button>
            </p>
          </form>
          {resend}
        </>
      )}

      {mode === 'otp' && !codeSent && (
        <>
          <p className="sub">Masuk tanpa password: kami kirim kode 6 digit ke email Anda.</p>
          <form className="panel" onSubmit={sendCode}>
            <label htmlFor="email" className="sub" style={labelStyle}>Email</label>
            <input id="email" type="email" inputMode="email" autoComplete="username" placeholder="nama@usaha.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
            {error && <p className="error" role="alert">{error}</p>}
            <p style={{ margin: '14px 0 0' }}><button type="submit" disabled={busy || !email.trim()}>{busy ? 'Mengirim…' : 'Kirim kode'}</button></p>
          </form>
          <p className="sub">{link('Kembali ke halaman masuk', 'password')}</p>
        </>
      )}

      {mode === 'otp' && codeSent && (
        <>
          <p className="sub">Masukkan kode dari email.</p>
          <form className="panel" onSubmit={otpLogin}>
            {info && <p className="sub" role="status" style={{ marginTop: 0 }}>{info}</p>}
            {codeInput}
            {error && <p className="error" role="alert">{error}</p>}
            <p style={{ margin: '14px 0 0' }}><button type="submit" disabled={busy || code.replace(/\s/g, '').length !== 6}>{busy ? 'Memeriksa…' : 'Masuk'}</button></p>
          </form>
          {resend}
        </>
      )}

      {mode === 'token' && (
        <>
          <p className="sub">Jalur cadangan: masuk dengan token pengguna dari administrator.</p>
          <form className="panel" onSubmit={tokenLogin}>
            <label htmlFor="token" className="sub" style={labelStyle}>Token pengguna</label>
            <input id="token" type="password" autoComplete="off" placeholder="api_…" value={token} onChange={(e) => setToken(e.target.value)} />
            {error && <p className="error" role="alert">{error}</p>}
            <p style={{ margin: '14px 0 0' }}><button type="submit" disabled={busy || !token.trim()}>{busy ? 'Memeriksa…' : 'Masuk'}</button></p>
          </form>
          <p className="sub">{link('Kembali ke halaman masuk', 'password')}</p>
        </>
      )}
    </main>
  );
}
