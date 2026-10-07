'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { StaffRow } from '@/lib/api';
import { manage, ROLE_LABEL } from '@/lib/manage';

export function StaffManager({ staff }: { staff: StaffRow[] }) {
  const router = useRouter();
  const [form, setForm] = useState({ id: '', name: '', role: 'CASHIER', pin: '' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<{ ok: true } | { ok: false; message: string }>, okMsg: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setNotice(okMsg);
    router.refresh();
    return r;
  }

  return (
    <>
      <section className="panel">
        <h2>Staf</h2>
        <table className="table">
          <thead><tr><th>Nama</th><th>ID</th><th>Peran</th><th>Status</th><th /></tr></thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id} className={s.active ? '' : 'off'}>
                <td>{s.name}</td>
                <td className="mono">{s.id}</td>
                <td>{ROLE_LABEL[s.role]}</td>
                <td>{s.active ? 'Aktif' : 'Nonaktif'}</td>
                <td className="row-actions">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      const pin = window.prompt(`PIN baru untuk ${s.name} (4–6 digit, tidak berurutan atau sama semua):`);
                      if (pin) void run(() => manage('PUT', `/v1/staff/${s.id}`, { pin }), `PIN ${s.name} diganti.`);
                    }}
                  >
                    Ganti PIN
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void run(() => manage('PUT', `/v1/staff/${s.id}`, { active: !s.active }), `${s.name} ${s.active ? 'dinonaktifkan' : 'diaktifkan'}.`)}
                  >
                    {s.active ? 'Nonaktifkan' : 'Aktifkan'}
                  </button>
                </td>
              </tr>
            ))}
            {staff.length === 0 && <tr><td colSpan={5} className="muted">Belum ada staf.</td></tr>}
          </tbody>
        </table>
        <p className="muted small">
          Perubahan sampai ke terminal dalam sekitar satu menit bila tersambung. Terminal yang offline memakai daftar terakhirnya, jadi staf yang dinonaktifkan masih bisa masuk di sana sampai tersambung kembali.
        </p>
      </section>

      <section className="panel">
        <h2>Tambah staf</h2>
        <form
          className="form-grid"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(() => manage('POST', '/v1/staff', form), `${form.name} ditambahkan.`);
            if (r) setForm({ id: '', name: '', role: 'CASHIER', pin: '' });
          }}
        >
          <label>Nama<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} required /></label>
          <label>ID (huruf kecil, angka, - atau _)<input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })} maxLength={32} required /></label>
          <label>Peran
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>PIN (4–6 digit)<input type="password" inputMode="numeric" autoComplete="new-password" value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, '') })} maxLength={6} required /></label>
          <div className="form-actions"><button type="submit" disabled={busy}>Tambah</button></div>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="ok-note" role="status">{notice}</p>}
      </section>
    </>
  );
}
