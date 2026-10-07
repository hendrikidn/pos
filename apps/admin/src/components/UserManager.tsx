'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { UserRow } from '@/lib/api';
import { dateWib } from '@/lib/format';
import { manage } from '@/lib/manage';

const ROLE = { OWNER: 'Owner', OPS: 'Ops', MANAGER: 'Manager', SUPERVISOR: 'Supervisor' } as const;

/** Pengguna dashboard yang login dengan kode email. Mengganti email atau menonaktifkan memutus semua sesi pengguna itu. */
export function UserManager({ tenantId, users }: { tenantId: string; users: UserRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', role: 'OWNER' });

  async function run(path: string, body: unknown, ok: string, method: 'POST' | 'PUT' = 'POST') {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await manage(path, body, method);
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
    <section className="panel">
      <h2>Pengguna dashboard (login email)</h2>
      <p className="muted small">
        Pengguna masuk dengan email dan password; password diatur sendiri lewat "Lupa password / atur password" (kode dikirim ke emailnya). Mengganti email menghapus password lama. Satu email hanya untuk satu pengguna di seluruh platform.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>Email</th><th>ID</th><th>Peran</th><th>Terakhir masuk</th><th>Password</th><th className="num">Sesi aktif</th><th>Status</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.active ? '' : 'off'}>
                <td>{u.email}</td>
                <td className="mono">{u.user_id}</td>
                <td>{ROLE[u.role]}</td>
                <td>{u.last_login_at ? dateWib(u.last_login_at) : <span className="muted">belum pernah</span>}</td>
                <td>{u.has_password ? 'Sudah diatur' : <span className="muted">belum</span>}</td>
                <td className="num">{u.active_sessions}</td>
                <td>{u.active ? 'Aktif' : 'Nonaktif'}</td>
                <td className="row-actions">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      const next = window.prompt(`Email baru untuk ${u.user_id}:\n\nSemua sesi pengguna ini langsung diputus, kode yang sudah terkirim ke email lama tidak berlaku lagi, dan password lama dihapus.`, u.email);
                      if (next && next.trim() && next.trim().toLowerCase() !== u.email.toLowerCase()) {
                        void run(`/v1/admin/tenants/${tenantId}/users/${u.id}`, { email: next.trim() }, `Email ${u.user_id} diganti.`, 'PUT');
                      }
                    }}
                  >
                    Ganti email
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      if (!u.active || window.confirm(`Nonaktifkan ${u.email}? Semua sesinya langsung diputus dan ia tidak bisa meminta kode lagi.`)) {
                        void run(`/v1/admin/tenants/${tenantId}/users/${u.id}`, { active: !u.active }, `${u.email} ${u.active ? 'dinonaktifkan' : 'diaktifkan'}.`, 'PUT');
                      }
                    }}
                  >
                    {u.active ? 'Nonaktifkan' : 'Aktifkan'}
                  </button>
                </td>
              </tr>
            ))}
            {users.length === 0 && <tr><td colSpan={8} className="muted">Belum ada pengguna email. Tambahkan email owner di bawah; sebelum itu owner hanya bisa masuk dengan token.</td></tr>}
          </tbody>
        </table>
      </div>
      <h2 style={{ marginTop: 18 }}>Tambah pengguna</h2>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(`/v1/admin/tenants/${tenantId}/users`, form, `${form.email} ditambahkan.`)) setForm({ email: '', role: form.role });
        }}
      >
        <label>Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required placeholder="nama@usaha.com" /></label>
        <label>Peran
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <div className="form-actions"><button type="submit" disabled={busy || !form.email.trim()}>Tambah</button></div>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="ok-note" role="status">{notice}</p>}
    </section>
  );
}
