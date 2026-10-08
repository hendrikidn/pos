'use client';

import { useState } from 'react';
import type { ModifierGroup } from '@/lib/api';

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);

/** Id unik dari nama; id yang sudah ada dipertahankan agar tidak berubah tiap disimpan. */
function uniqueId(base: string, taken: Set<string>, fallback: string): string {
  const root = slug(base) || fallback;
  let id = root;
  for (let n = 2; taken.has(id); n++) id = `${root}-${n}`;
  taken.add(id);
  return id;
}

type Draft = { id?: string; name: string; min: number; max: number; options: { id?: string; name: string; price: string }[] };

const PRESETS: { label: string; group: Draft }[] = [
  { label: '+ Ukuran', group: { name: 'Ukuran', min: 1, max: 1, options: [{ name: 'Regular', price: '0' }, { name: 'Large', price: '6000' }] } },
  { label: '+ Level pedas', group: { name: 'Level pedas', min: 1, max: 1, options: [{ name: 'Tidak pedas', price: '0' }, { name: 'Sedang', price: '0' }, { name: 'Pedas', price: '0' }] } },
  { label: '+ Suhu', group: { name: 'Suhu', min: 1, max: 1, options: [{ name: 'Panas', price: '0' }, { name: 'Dingin', price: '0' }] } },
  { label: '+ Tambahan', group: { name: 'Tambahan', min: 0, max: 2, options: [{ name: 'Extra shot', price: '5000' }, { name: 'Oat milk', price: '8000' }] } },
];

const toDraft = (g: ModifierGroup): Draft => ({ ...g, options: g.options.map((o) => ({ id: o.id, name: o.name, price: String(o.price) })) });

/** Mengubah draf menjadi bentuk API (id dibuat dari nama). Mengembalikan pesan kesalahan bila ada yang kurang. */
export function buildGroups(drafts: Draft[]): ModifierGroup[] | string {
  const gIds = new Set<string>();
  const oIds = new Set<string>(); // unik di seluruh menu, bukan per grup
  const out: ModifierGroup[] = [];
  for (const [gi, d] of drafts.entries()) {
    if (!d.name.trim()) return `Grup ${gi + 1}: nama wajib diisi.`;
    if (d.options.length === 0) return `Grup "${d.name}": tambahkan minimal satu opsi.`;
    const options: ModifierGroup['options'] = [];
    for (const o of d.options) {
      if (!o.name.trim()) return `Grup "${d.name}": ada opsi tanpa nama.`;
      const price = Number(o.price || 0);
      if (!Number.isInteger(price) || price < 0) return `Opsi "${o.name}": harga harus bilangan bulat ≥ 0.`;
      options.push({ id: o.id && !oIds.has(o.id) ? (oIds.add(o.id), o.id) : uniqueId(o.name, oIds, 'opsi'), name: o.name.trim(), price });
    }
    if (d.min < 0 || d.max < 1 || d.min > d.max || d.max > options.length) {
      return `Grup "${d.name}": batas pilihan tidak masuk akal (minimal ≤ maksimal ≤ jumlah opsi).`;
    }
    out.push({ id: d.id && !gIds.has(d.id) ? (gIds.add(d.id), d.id) : uniqueId(d.name, gIds, 'grup'), name: d.name.trim(), min: d.min, max: d.max, options });
  }
  return out;
}

const modeOf = (g: Draft): 'req' | 'opt' | 'many' => (g.max === 1 ? (g.min === 1 ? 'req' : 'opt') : 'many');

export function ModifierEditor({
  menuName, groups, busy, onSave, onCancel,
}: {
  menuName: string;
  groups: ModifierGroup[];
  busy: boolean;
  onSave: (groups: ModifierGroup[]) => void;
  onCancel: () => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() => groups.map(toDraft));
  const [error, setError] = useState<string | null>(null);
  const patch = (gi: number, fn: (g: Draft) => Draft) => setDrafts((d) => d.map((g, i) => (i === gi ? fn(g) : g)));

  function setMode(gi: number, mode: 'req' | 'opt' | 'many') {
    patch(gi, (g) => (mode === 'req' ? { ...g, min: 1, max: 1 } : mode === 'opt' ? { ...g, min: 0, max: 1 } : { ...g, min: 0, max: Math.min(Math.max(2, g.options.length), g.options.length || 2) }));
  }

  return (
    <div className="mod-editor">
      <h3>Varian dan tambahan: {menuName}</h3>
      <p className="muted small">
        Varian (ukuran, level pedas) = grup yang wajib dipilih satu. Tambahan (topping, extra shot) = grup opsional, boleh lebih dari satu.
        Harga opsi ditambahkan ke harga menu.
      </p>

      {drafts.map((g, gi) => (
        <fieldset key={gi} className="mod-group">
          <div className="mod-head">
            <label>Nama grup<input value={g.name} maxLength={40} onChange={(e) => patch(gi, (x) => ({ ...x, name: e.target.value }))} /></label>
            <label>Cara memilih
              <select value={modeOf(g)} onChange={(e) => setMode(gi, e.target.value as 'req' | 'opt' | 'many')}>
                <option value="req">Wajib pilih satu</option>
                <option value="opt">Opsional, satu saja</option>
                <option value="many">Boleh beberapa</option>
              </select>
            </label>
            {modeOf(g) === 'many' && (
              <>
                <label>Minimal<input inputMode="numeric" value={g.min} onChange={(e) => patch(gi, (x) => ({ ...x, min: Number(e.target.value.replace(/\D/g, '')) }))} /></label>
                <label>Maksimal<input inputMode="numeric" value={g.max} onChange={(e) => patch(gi, (x) => ({ ...x, max: Number(e.target.value.replace(/\D/g, '')) }))} /></label>
              </>
            )}
            <button type="button" className="secondary danger" onClick={() => setDrafts((d) => d.filter((_, i) => i !== gi))}>Hapus grup</button>
          </div>
          <ul className="mod-opts">
            {g.options.map((o, oi) => (
              <li key={oi}>
                <input aria-label="Nama opsi" placeholder="Nama opsi" value={o.name} maxLength={40} onChange={(e) => patch(gi, (x) => ({ ...x, options: x.options.map((y, j) => (j === oi ? { ...y, name: e.target.value } : y)) }))} />
                <span className="mod-price">+ Rp<input aria-label="Tambahan harga" inputMode="numeric" value={o.price} onChange={(e) => patch(gi, (x) => ({ ...x, options: x.options.map((y, j) => (j === oi ? { ...y, price: e.target.value.replace(/\D/g, '') } : y)) }))} /></span>
                <button type="button" className="secondary" aria-label={`Hapus opsi ${o.name || oi + 1}`} onClick={() => patch(gi, (x) => {
                  const options = x.options.filter((_, j) => j !== oi);
                  return { ...x, options, max: Math.max(1, Math.min(x.max, options.length)), min: Math.min(x.min, options.length) };
                })}>✕</button>
              </li>
            ))}
          </ul>
          <button type="button" className="secondary" onClick={() => patch(gi, (x) => ({ ...x, options: [...x.options, { name: '', price: '0' }] }))}>+ Opsi</button>
        </fieldset>
      ))}

      <div className="mod-presets">
        {PRESETS.map((p) => (
          <button key={p.label} type="button" className="secondary" disabled={drafts.length >= 8} onClick={() => setDrafts((d) => [...d, { ...p.group, options: p.group.options.map((o) => ({ ...o })) }])}>{p.label}</button>
        ))}
        <button type="button" className="secondary" disabled={drafts.length >= 8} onClick={() => setDrafts((d) => [...d, { name: '', min: 0, max: 1, options: [{ name: '', price: '0' }] }])}>+ Grup kosong</button>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" className="secondary" onClick={onCancel}>Batal</button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const r = buildGroups(drafts);
            if (typeof r === 'string') return setError(r);
            setError(null);
            onSave(r);
          }}
        >
          Simpan {drafts.length === 0 ? '(tanpa opsi)' : ''}
        </button>
      </div>
    </div>
  );
}
