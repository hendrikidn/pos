'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { MenuCostRow, MenuRow } from '@/lib/api';
import { resizeToJpeg } from '@/lib/image';
import { manage } from '@/lib/manage';
import { ModifierEditor } from './ModifierEditor';

const rp = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;

export function MenuManager({ items, costs = [] }: { items: MenuRow[]; costs?: MenuCostRow[] }) {
  const costOf = new Map(costs.map((c) => [c.id, c]));
  const router = useRouter();
  const [form, setForm] = useState({ id: '', name: '', price: '', category: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

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
          <thead><tr><th>Foto</th><th>Menu</th><th>Kategori</th><th className="num">Harga</th><th className="num">HPP / margin</th><th>Status</th><th /></tr></thead>
          <tbody>
            {items.flatMap((m) => [
              <tr key={m.id} className={m.active ? '' : 'off'}>
                <td data-label="Foto" className="thumb-cell">
                  {m.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="thumb" src={`/api/menu-image/${m.id}?v=${m.image}`} alt={`Foto ${m.name}`} width={56} height={56} loading="lazy" />
                  ) : (
                    <span className="thumb thumb-empty" aria-hidden>{m.name.slice(0, 1).toUpperCase()}</span>
                  )}
                </td>
                <td data-label="Menu">
                  {m.name}
                  <div className="muted small mono">{m.id}</div>
                  {m.modifierGroups.length > 0 && <div className="muted small">{m.modifierGroups.map((g) => g.name).join(' · ')}</div>}
                </td>
                <td data-label="Kategori">{m.category}</td>
                <td data-label="Harga" className="num">{rp(m.price)}</td>
                <td data-label="HPP / margin" className="num">
                  {(() => {
                    const c = costOf.get(m.id);
                    if (!c || c.cost === null) return <span className="muted small">tanpa resep</span>;
                    return (
                      <>
                        {c.missing.length > 0 ? (
                          <div className="small delta neg" title={`Belum ada harga pokok: ${c.missing.join(', ')}`}>HPP belum lengkap<br />(harga bahan kurang)</div>
                        ) : (
                          <>
                            {rp(c.cost)}
                            <div className={`small ${c.marginPct !== null && c.marginPct < 30 ? 'delta neg' : 'muted'}`}>{c.marginPct}% margin</div>
                          </>
                        )}
                      </>
                    );
                  })()}
                </td>
                <td data-label="Status">{m.active ? 'Aktif' : 'Nonaktif'}</td>
                <td className="row-actions">
                  <label className={`secondary btn-like ${busy ? 'disabled' : ''}`}>
                    {m.image ? 'Ganti foto' : 'Unggah foto'}
                    <input
                      type="file" accept="image/*" hidden disabled={busy}
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        let img: Awaited<ReturnType<typeof resizeToJpeg>>;
                        try {
                          img = await resizeToJpeg(file);
                        } catch (err) {
                          return void setError(err instanceof Error ? err.message : 'Gambar tidak bisa diproses.');
                        }
                        void run(() => manage('PUT', `/v1/menu/${m.id}/image`, img));
                      }}
                    />
                  </label>
                  {m.image && <button className="secondary" disabled={busy} onClick={() => void run(() => manage('DELETE', `/v1/menu/${m.id}/image`))}>Hapus foto</button>}
                  <button className="secondary" disabled={busy} onClick={() => setEditing(editing === m.id ? null : m.id)}>
                    Varian{m.modifierGroups.length > 0 ? ` (${m.modifierGroups.length})` : ''}
                  </button>
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
              </tr>,
              ...(editing === m.id
                ? [
                    <tr key={`${m.id}-mod`} className="mod-row">
                      <td colSpan={7}>
                        <ModifierEditor
                          menuName={m.name}
                          groups={m.modifierGroups}
                          busy={busy}
                          onCancel={() => setEditing(null)}
                          onSave={async (modifierGroups) => {
                            const r = await run(() => manage('PUT', `/v1/menu/${m.id}`, { modifierGroups }));
                            if (r) setEditing(null);
                          }}
                        />
                      </td>
                    </tr>,
                  ]
                : []),
            ])}
            {items.length === 0 && <tr><td colSpan={7} className="muted">Belum ada menu.</td></tr>}
          </tbody>
        </table>
        <p className="muted small">Setiap perubahan harga dicatat di log audit beserta harga lama dan barunya. Perubahan varian sampai ke terminal pada pembaruan konfigurasi berikutnya; order yang sedang berjalan tidak berubah.</p>
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
