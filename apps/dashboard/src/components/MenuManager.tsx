'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { MenuRow } from '@/lib/api';
import { manage } from '@/lib/manage';

const rp = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;

export function MenuManager({ items }: { items: MenuRow[] }) {
  const router = useRouter();
  const [form, setForm] = useState({ id: '', name: '', price: '', category: '' });
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
        <h2>Menu</h2>
        <table className="table">
          <thead><tr><th>Menu</th><th>Kategori</th><th className="num">Harga</th><th>Status</th><th /></tr></thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.id} className={m.active ? '' : 'off'}>
                <td>{m.name}<div className="muted small mono">{m.id}</div></td>
                <td>{m.category}</td>
                <td className="num">{rp(m.price)}</td>
                <td>{m.active ? 'Aktif' : 'Nonaktif'}</td>
                <td className="row-actions">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      const v = window.prompt(`Harga baru untuk ${m.name} (rupiah, bilangan bulat):`, String(m.price));
                      if (v === null) return;
                      void run(() => manage('PUT', `/v1/menu/${m.id}`, { price: Number(v) }));
                    }}
                  >
                    Ubah harga
                  </button>
                  <button className="secondary" disabled={busy} onClick={() => void run(() => manage('PUT', `/v1/menu/${m.id}`, { active: !m.active }))}>
                    {m.active ? 'Nonaktifkan' : 'Aktifkan'}
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={5} className="muted">Belum ada menu.</td></tr>}
          </tbody>
        </table>
        <p className="muted small">Setiap perubahan harga dicatat di log audit beserta harga lama dan barunya.</p>
      </section>

      <section className="panel">
        <h2>Tambah menu</h2>
        <form
          className="form-grid"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(() => manage('POST', '/v1/menu', { ...form, price: Number(form.price) }));
            if (r) setForm({ id: '', name: '', price: '', category: '' });
          }}
        >
          <label>Nama<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} required /></label>
          <label>ID<input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })} maxLength={32} required /></label>
          <label>Kategori<input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} maxLength={30} required list="cats" />
            <datalist id="cats">{[...new Set(items.map((m) => m.category))].map((c) => <option key={c} value={c} />)}</datalist>
          </label>
          <label>Harga (Rp)<input inputMode="numeric" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value.replace(/\D/g, '') })} required /></label>
          <div className="form-actions"><button type="submit" disabled={busy}>Tambah</button></div>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
      </section>
    </>
  );
}
