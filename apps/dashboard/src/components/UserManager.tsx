'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { DashboardUser } from '@/lib/api';
import { wibDateTime } from '@/lib/format';
import { manage } from '@/lib/manage';

const ROLE_LABEL = { OWNER: 'Owner', OPS: 'Ops', MANAGER: 'Manager', SUPERVISOR: 'Supervisor' } as const;
const INVITABLE = ['OPS', 'MANAGER', 'SUPERVISOR'] as const;

/** Hak tiap peran sesuai yang diberlakukan API. Dipakai sebagai petunjuk saat memilih peran. */
const ROLE_HELP: Record<(typeof INVITABLE)[number], string> = {
  OPS: 'Meninjau insiden, mengunggah laporan bank dan slip settlement, mengelola menu, dan memasang perangkat. Tidak mengubah staf, outlet, atau pengaturan.',
  MANAGER: 'Melihat insiden, settlement EDC, dan menu. Hanya baca.',
  SUPERVISOR: 'Melihat insiden saja. Hanya baca.',
};

export function UserManager({ users }: { users: DashboardUser[] }) {
  const router = useRouter();
  const [form, setForm] = useState({ email: '', userId: '', role: 'MANAGER' as (typeof INVITABLE)[number] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(method: 'POST' | 'PUT', path: string, body: unknown, ok: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await manage(method, path, body);
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return false;
    }
    setNotice(ok);
    router.refresh();
    return true;
  }

  return (
    <>
      <section className="panel">
        <h2>Pengguna dashboard</h2>
        <p className="muted small">Pengguna masuk dengan email dan password. Pengguna baru mengatur password pertama kali lewat "Lupa password / atur password" di halaman masuk (kode dikirim ke emailnya). Satu email hanya untuk satu pengguna.</p>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>Email</th><th>ID</th><th>Peran</th><th>Terakhir masuk</th><th>Password</th><th className="num">Sesi aktif</th><th>Status</th><th /></tr></thead>
            <tbody>
              {users.map((u) => {
                const owner = u.role === 'OWNER';
                return (
                  <tr key={u.id} className={u.active ? '' : 'off'}>
                    <td>{u.email}</td>
                    <td className="mono">{u.user_id}</td>
                    <td>
                      {owner ? ROLE_LABEL.OWNER : (
                        <select
                          aria-label={`Peran ${u.email}`}
                          value={u.role}
                          disabled={busy}
                          onChange={(e) => {
                            if (window.confirm(`Ubah peran ${u.email} menjadi ${ROLE_LABEL[e.target.value as keyof typeof ROLE_LABEL]}? Sesinya diputus dan ia harus masuk lagi.`)) {
                              void run('PUT', `/v1/users/${u.id}`, { role: e.target.value }, `Peran ${u.email} diubah.`);
                            }
                          }}
                        >
                          {INVITABLE.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                        </select>
                      )}
                    </td>
                    <td>{u.last_login_at ? wibDateTime(Date.parse(u.last_login_at)) : <span className="muted">belum pernah</span>}</td>
                    <td>{u.has_password ? 'Sudah diatur' : <span className="muted">belum</span>}</td>
                    <td className="num">{u.active_sessions}</td>
                    <td>{u.active ? 'Aktif' : 'Nonaktif'}</td>
                    <td className="row-actions">
                      {owner ? (
                        <span className="muted small">dikelola administrator</span>
                      ) : (
                        <>
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => {
                              const next = window.prompt(`Email baru untuk ${u.user_id}:\n\nSesinya diputus, kode yang sudah terkirim ke email lama tidak berlaku lagi, dan password lama dihapus (pemilik email baru mengaturnya sendiri).`, u.email);
                              if (next && next.trim() && next.trim().toLowerCase() !== u.email.toLowerCase()) {
                                void run('PUT', `/v1/users/${u.id}`, { email: next.trim() }, `Email ${u.user_id} diganti.`);
                              }
                            }}
                          >
                            Ganti email
                          </button>
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => {
                              if (!u.active || window.confirm(`Nonaktifkan ${u.email}? Sesinya langsung diputus dan ia tidak bisa masuk lagi.`)) {
                                void run('PUT', `/v1/users/${u.id}`, { active: !u.active }, `${u.email} ${u.active ? 'dinonaktifkan' : 'diaktifkan'}.`);
                              }
                            }}
                          >
                            {u.active ? 'Nonaktifkan' : 'Aktifkan'}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 && <tr><td colSpan={8} className="muted">Belum ada pengguna.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Undang pengguna</h2>
        <form
          className="form-grid"
          onSubmit={async (e) => {
            e.preventDefault();
            const body = { email: form.email, role: form.role, ...(form.userId.trim() ? { userId: form.userId.trim() } : {}) };
            if (await run('POST', '/v1/users', body, `${form.email} ditambahkan. Ia bisa masuk dengan email itu sekarang.`)) setForm({ ...form, email: '', userId: '' });
          }}
        >
          <label>Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required placeholder="nama@usaha.com" /></label>
          <label>Peran
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as (typeof INVITABLE)[number] })}>
              {INVITABLE.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          <label>ID staf POS (opsional)<input value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value.toLowerCase() })} maxLength={40} placeholder="mis. rina" /></label>
          <div className="form-actions"><button type="submit" disabled={busy || !form.email.trim()}>Undang</button></div>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="ok-note" role="status">{notice}</p>}
        <p className="muted small"><strong>{ROLE_LABEL[form.role]}:</strong> {ROLE_HELP[form.role]}</p>
        <p className="muted small">
          Bila orang ini juga kasir atau staf di POS, isi <strong>ID staf POS</strong> dengan ID yang sama di tab Staf &amp; PIN. Dengan begitu insiden yang
          melibatkan dirinya tidak ditampilkan kepadanya. Tanpa itu, ID dibuat dari emailnya.
        </p>
        <p className="muted small">Akun owner tambahan hanya bisa dibuat oleh administrator platform.</p>
      </section>
    </>
  );
}
