'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { MemberRow } from '@/lib/api';
import { manage } from '@/lib/manage';
import { wibDate } from '@/lib/format';

export function MemberManager({ members, query }: { members: MemberRow[]; query: string }) {
  const router = useRouter();
  const [form, setForm] = useState({ phone: '', name: '' });
  const [q, setQ] = useState(query);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<{ ok: true } | { ok: false; message: string }>) {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) return void setError(r.message);
    router.refresh();
    return r;
  }

  return (
    <>
      <section className="panel">
        <h2>Member</h2>
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); router.push(q.trim() ? `/settings/members?q=${encodeURIComponent(q.trim())}` : '/settings/members'); }}>
          <input aria-label="Cari member" placeholder="Cari nama atau nomor HP" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="submit" className="secondary">Cari</button>
        </form>
        <table className="table">
          <thead><tr><th>Member</th><th>Nomor HP</th><th className="num">Poin</th><th>Aktivitas poin terakhir</th><th>Status</th><th /></tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className={m.active ? '' : 'off'}>
                <td data-label="Member">{m.name}</td>
                <td data-label="Nomor HP" className="mono">{m.phoneMasked}</td>
                <td data-label="Poin" className={`num ${m.points < 0 ? 'neg' : ''}`}>{m.points.toLocaleString('id-ID')}</td>
                <td data-label="Aktivitas">{m.lastActivityMs ? wibDate(m.lastActivityMs) : '–'}</td>
                <td data-label="Status">{m.active ? 'Aktif' : 'Nonaktif'}</td>
                <td className="row-actions">
                  <button className="secondary" disabled={busy} onClick={() => {
                    const v = window.prompt(`Nama baru untuk ${m.name}:`, m.name);
                    if (v && v.trim()) void run(() => manage('PUT', `/v1/members/${m.id}`, { name: v.trim() }));
                  }}>Ubah nama</button>
                  <button className="secondary" disabled={busy} onClick={() => void run(() => manage('PUT', `/v1/members/${m.id}`, { active: !m.active }))}>{m.active ? 'Nonaktifkan' : 'Aktifkan'}</button>
                </td>
              </tr>
            ))}
            {members.length === 0 && <tr><td colSpan={6} className="muted">{query ? 'Tidak ada member yang cocok.' : 'Belum ada member. Kasir bisa mendaftarkannya langsung dari order.'}</td></tr>}
          </tbody>
        </table>
        <p className="muted small">
          Saldo poin dihitung server dari pembayaran dan penukaran, bukan dari terminal. Saldo negatif (merah) berarti poin ditukar melebihi saldo dan sudah menjadi temuan di Insiden.
          Nomor HP hanya tampil empat digit terakhir. Member yang dinonaktifkan tidak bisa dicari kasir. Pengaturan nilai poin ada di Pengaturan → Outlet.
        </p>
      </section>

      <section className="panel">
        <h2>Tambah member</h2>
        <form className="form-grid" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => manage('POST', '/v1/members', form)); if (r) setForm({ phone: '', name: '' }); }}>
          <label>Nama<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} required /></label>
          <label>Nomor HP<input inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="0812 3456 7890" required /></label>
          <div className="form-actions"><button type="submit" disabled={busy}>Tambah</button></div>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
      </section>
    </>
  );
}
