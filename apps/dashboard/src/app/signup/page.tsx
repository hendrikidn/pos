'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Logo } from '@/components/Icons';

const PASSWORD_MIN = 10;

async function post(path: string, body: unknown): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  if (!res) return { ok: false, message: 'Tidak dapat menghubungi server.' };
  if (res.ok) return { ok: true };
  const j = (await res.json().catch(() => ({}))) as { message?: string | string[] };
  return { ok: false, message: Array.isArray(j.message) ? j.message.join('; ') : j.message };
}

/** Pendaftaran mandiri: isi data usaha, lalu masukkan kode dari email dan buat password. Uji coba 14 hari tanpa kartu. */
export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({ businessName: '', outletName: '', ownerName: '', email: '', website: '' });
  const [step, setStep] = useState<'form' | 'code'>('form');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await post('/api/auth/signup', form);
    setBusy(false);
    if (!r.ok) return setError(r.message ?? 'Pendaftaran gagal.');
    setStep('code');
  }

  async function finish(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < PASSWORD_MIN) return setError(`Password minimal ${PASSWORD_MIN} karakter.`);
    if (password !== confirm) return setError('Konfirmasi password tidak sama.');
    setBusy(true);
    const r = await post('/api/auth/reset', { email: form.email.trim(), code: code.trim(), password });
    setBusy(false);
    if (!r.ok) return setError(r.message ?? 'Kode salah atau sudah kedaluwarsa.');
    router.push('/');
    router.refresh();
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <main className="login">
      <div className="login-brand">
        <Logo size={56} />
        <h1>Anatta POS</h1>
        <p>POS F&amp;B dengan deteksi kecurangan kasir</p>
      </div>
      <div>
        {step === 'form' ? (
          <form className="panel" onSubmit={submit}>
            <h2>Coba gratis 14 hari</h2>
            <p className="sub">Tanpa kartu kredit. Setelah mendaftar Anda mengatur password lewat kode yang dikirim ke email.</p>
            <label className="sub" htmlFor="bn">Nama usaha</label>
            <input id="bn" value={form.businessName} onChange={set('businessName')} maxLength={60} required />
            <label className="sub" htmlFor="on">Nama outlet pertama</label>
            <input id="on" value={form.outletName} onChange={set('outletName')} maxLength={60} required placeholder="mis. Cabang Utama" />
            <label className="sub" htmlFor="ow">Nama Anda</label>
            <input id="ow" value={form.ownerName} onChange={set('ownerName')} maxLength={60} required autoComplete="name" />
            <label className="sub" htmlFor="em">Email</label>
            <input id="em" type="email" value={form.email} onChange={set('email')} maxLength={254} required autoComplete="email" />
            {/* Jebakan bot: manusia tidak melihat dan tidak mengisinya. */}
            <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px' }}>
              <label htmlFor="web">Website</label>
              <input id="web" tabIndex={-1} autoComplete="off" value={form.website} onChange={set('website')} />
            </div>
            {error && <p className="error" role="alert">{error}</p>}
            <p><button type="submit" disabled={busy}>{busy ? 'Mendaftarkan…' : 'Daftar'}</button></p>
            <p className="sub">Sudah punya akun? <a href="/login">Masuk</a></p>
          </form>
        ) : (
          <form className="panel" onSubmit={finish}>
            <h2>Cek email Anda</h2>
            <p className="sub">Kami mengirim kode 6 digit ke <b>{form.email.trim()}</b> (berlaku 10 menit). Masukkan kode dan buat password.</p>
            <label className="sub" htmlFor="code">Kode 6 digit</label>
            <input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, ''))} required style={{ fontSize: 24, letterSpacing: 6, textAlign: 'center' }} />
            <label className="sub" htmlFor="pw">Password baru (min. {PASSWORD_MIN} karakter)</label>
            <input id="pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <label className="sub" htmlFor="pw2">Ulangi password</label>
            <input id="pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            {error && <p className="error" role="alert">{error}</p>}
            <p><button type="submit" disabled={busy}>{busy ? 'Menyimpan…' : 'Selesai dan masuk'}</button></p>
            <p className="sub">Tidak menerima email? Periksa folder spam, atau <a href="/login">minta kode baru di halaman masuk</a>.</p>
          </form>
        )}
      </div>
    </main>
  );
}
