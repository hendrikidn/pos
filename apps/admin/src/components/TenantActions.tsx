'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { manage } from '@/lib/manage';

/** Ganti nama, tangguhkan, dan aktifkan kembali tenant. Penangguhan memutus semua token tenant itu seketika, tanpa menghapus data. */
export function TenantActions({ id, name, suspended }: { id: string; name: string; suspended: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newName, setNewName] = useState(name);

  async function run(path: string, body: unknown, ok: string, method: 'POST' | 'PUT' = 'POST') {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await manage(path, body, method);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setNotice(ok);
    router.refresh();
  }

  return (
    <section className="panel">
      <h2>Kelola tenant</h2>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void run(`/v1/admin/tenants/${id}`, { name: newName }, 'Nama tenant diubah.', 'PUT');
        }}
      >
        <label>Nama tenant<input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} required /></label>
        <div className="form-actions"><button type="submit" className="secondary" disabled={busy || !newName.trim() || newName.trim() === name}>Simpan nama</button></div>
      </form>
      <div className="actions" style={{ marginTop: 14 }}>
        {suspended ? (
          <button type="button" disabled={busy} onClick={() => void run(`/v1/admin/tenants/${id}/reactivate`, {}, 'Tenant diaktifkan kembali.')}>Aktifkan kembali</button>
        ) : (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              const reason = window.prompt(`Tangguhkan "${name}"?\n\nSemua token pengguna dan perangkatnya langsung ditolak. Data tidak dihapus dan bisa diaktifkan kembali.\n\nAlasan (opsional, hanya terlihat oleh admin):`);
              if (reason !== null) void run(`/v1/admin/tenants/${id}/suspend`, { reason }, 'Tenant ditangguhkan.');
            }}
          >
            Tangguhkan tenant
          </button>
        )}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="ok-note" role="status">{notice}</p>}
    </section>
  );
}
