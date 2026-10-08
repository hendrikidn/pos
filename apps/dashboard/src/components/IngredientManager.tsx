'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Boms, Ingredient, MenuRow, Recipes } from '@/lib/api';
import { manage } from '@/lib/manage';

const UNIT_LABEL = { g: 'gram (g)', ml: 'mililiter (ml)', pcs: 'buah (pcs)' } as const;

type Line = { ingredientId: string; qty: string };
type Scopes = Record<string, Line[]>; // '' = resep dasar, selain itu id opsi

const toLines = (m: Record<string, number> | undefined): Line[] => Object.entries(m ?? {}).map(([ingredientId, q]) => ({ ingredientId, qty: String(q) }));

function RecipeEditor({ menu, ingredients, recipe, onDone }: { menu: MenuRow; ingredients: Ingredient[]; recipe: Recipes[string] | undefined; onDone: () => void }) {
  const initial: Scopes = { '': toLines(recipe?.base) };
  for (const g of menu.modifierGroups) for (const o of g.options) initial[o.id] = toLines(recipe?.options[o.id]);
  const [scopes, setScopes] = useState<Scopes>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = ingredients.filter((i) => i.active);
  const unitOf = (id: string) => ingredients.find((i) => i.id === id)?.unit ?? '';

  const edit = (scope: string, fn: (l: Line[]) => Line[]) => setScopes((s) => ({ ...s, [scope]: fn(s[scope] ?? []) }));

  async function save() {
    setBusy(true);
    setError(null);
    for (const [scope, lines] of Object.entries(scopes)) {
      if (JSON.stringify(lines) === JSON.stringify(initial[scope])) continue;
      const r = await manage('PUT', `/v1/menu/${encodeURIComponent(menu.id)}/recipe`, {
        ...(scope ? { optionId: scope } : {}),
        lines: lines.filter((l) => l.ingredientId).map((l) => ({ ingredientId: l.ingredientId, qty: Number(l.qty) })),
      });
      if (!r.ok) {
        setBusy(false);
        return setError(`${scope ? `Opsi ${scope}` : 'Resep dasar'}: ${r.message}`);
      }
    }
    setBusy(false);
    onDone();
  }

  const block = (scope: string, title: string, hint?: string) => (
    <fieldset className="mod-group" key={scope || 'base'}>
      <legend><b>{title}</b>{hint && <span className="muted small"> · {hint}</span>}</legend>
      {(scopes[scope] ?? []).length === 0 && <p className="muted small" style={{ margin: '4px 0' }}>Belum ada bahan.</p>}
      <ul className="mod-opts">
        {(scopes[scope] ?? []).map((l, i) => (
          <li key={i}>
            <select aria-label="Bahan" value={l.ingredientId} onChange={(e) => edit(scope, (ls) => ls.map((x, j) => (j === i ? { ...x, ingredientId: e.target.value } : x)))}>
              <option value="">Pilih bahan…</option>
              {active.map((a) => <option key={a.id} value={a.id}>{a.name}{a.kind === 'SEMI' ? ' (setengah jadi)' : ''}</option>)}
            </select>
            <span className="mod-price">
              <input aria-label="Jumlah per porsi" inputMode="numeric" value={l.qty} onChange={(e) => edit(scope, (ls) => ls.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/\D/g, '') } : x)))} />
              {unitOf(l.ingredientId)}
            </span>
            <button type="button" className="secondary" aria-label="Hapus bahan" onClick={() => edit(scope, (ls) => ls.filter((_, j) => j !== i))}>✕</button>
          </li>
        ))}
      </ul>
      <button type="button" className="secondary" onClick={() => edit(scope, (ls) => [...ls, { ingredientId: '', qty: '' }])}>+ Bahan</button>
    </fieldset>
  );

  return (
    <div className="mod-editor">
      <h3>Resep: {menu.name}</h3>
      <p className="muted small">Bahan yang terpakai per satu porsi. Setiap penjualan mengurangi stok sebesar resep × jumlah porsi; opsi yang dipilih menambah bahan miliknya.</p>
      {block('', 'Per porsi')}
      {menu.modifierGroups.flatMap((g) => g.options.map((o) => block(o.id, `${g.name}: ${o.name}`, 'tambahan bila dipilih')))}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" className="secondary" onClick={onDone}>Batal</button>
        <button type="button" disabled={busy} onClick={() => void save()}>Simpan resep</button>
      </div>
    </div>
  );
}

/** BOM satu bahan setengah jadi: bahan per BATCH; hasil batch menentukan kebutuhan per satuan. */
function BomEditor({ semi, ingredients, bom, onDone }: { semi: Ingredient; ingredients: Ingredient[]; bom: Boms[string] | undefined; onDone: () => void }) {
  const [lines, setLines] = useState<Line[]>(toLines(bom?.lines));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = ingredients.filter((i) => i.active && i.id !== semi.id);
  const unitOf = (id: string) => ingredients.find((i) => i.id === id)?.unit ?? '';
  const edit = (fn: (l: Line[]) => Line[]) => setLines(fn);
  async function save() {
    setBusy(true);
    setError(null);
    const r = await manage('PUT', `/v1/ingredients/${encodeURIComponent(semi.id)}/bom`, { lines: lines.filter((l) => l.ingredientId).map((l) => ({ ingredientId: l.ingredientId, qty: Number(l.qty) })) });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    onDone();
  }
  return (
    <div className="mod-editor">
      <h3>BOM: {semi.name}</h3>
      <p className="muted small">Bahan yang dipakai untuk membuat SATU batch, yang menghasilkan {semi.batchYield?.toLocaleString('id-ID')} {semi.unit}. Bahan lain (termasuk bahan setengah jadi) boleh dipakai, maksimal 5 tingkat; siklus ditolak.</p>
      <ul className="mod-opts">
        {lines.map((l, i) => (
          <li key={i}>
            <select aria-label="Bahan" value={l.ingredientId} onChange={(e) => edit((ls) => ls.map((x, j) => (j === i ? { ...x, ingredientId: e.target.value } : x)))}>
              <option value="">Pilih bahan…</option>
              {choices.map((a) => <option key={a.id} value={a.id}>{a.name}{a.kind === 'SEMI' ? ' (setengah jadi)' : ''}</option>)}
            </select>
            <span className="mod-price">
              <input aria-label="Jumlah per batch" inputMode="numeric" value={l.qty} onChange={(e) => edit((ls) => ls.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/\D/g, '') } : x)))} />
              {unitOf(l.ingredientId)}
            </span>
            <button type="button" className="secondary" aria-label="Hapus bahan" onClick={() => edit((ls) => ls.filter((_, j) => j !== i))}>✕</button>
          </li>
        ))}
      </ul>
      <button type="button" className="secondary" onClick={() => edit((ls) => [...ls, { ingredientId: '', qty: '' }])}>+ Bahan</button>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" className="secondary" onClick={onDone}>Batal</button>
        <button type="button" disabled={busy} onClick={() => void save()}>Simpan BOM</button>
      </div>
    </div>
  );
}

export function IngredientManager({ ingredients, menu, recipes, boms }: { ingredients: Ingredient[]; menu: MenuRow[]; recipes: Recipes; boms: Boms }) {
  const router = useRouter();
  const [form, setForm] = useState({ id: '', name: '', unit: 'g', minStock: '0', kind: 'RAW', yieldPercent: '100', batchYield: '' });
  const [bomOf, setBomOf] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        <h2>Bahan baku</h2>
        <table className="table">
          <thead><tr><th>Bahan</th><th>Satuan</th><th>Jenis</th><th className="num">Stok minimum</th><th>Status</th><th /></tr></thead>
          <tbody>
            {ingredients.flatMap((i) => [
              <tr key={i.id} className={i.active ? '' : 'off'}>
                <td data-label="Bahan">{i.name}<div className="muted small mono">{i.id}</div></td>
                <td data-label="Satuan">{i.unit}</td>
                <td data-label="Jenis">
                  {i.kind === 'SEMI' ? <>Setengah jadi<div className="muted small">hasil {i.batchYield?.toLocaleString('id-ID')} {i.unit}/batch · {Object.keys(boms[i.id]?.lines ?? {}).length === 0 ? <b className="delta neg">BOM belum diisi</b> : `${Object.keys(boms[i.id]!.lines).length} bahan`}{i.avgCost ? ` · Rp ${i.avgCost.toLocaleString('id-ID', { maximumFractionDigits: 4 })}/${i.unit}` : ''}</div></>
                    : <>Bahan baku{(i.yieldPercent ?? 100) < 100 && <div className="muted small">susut: {i.yieldPercent}% terpakai</div>}</>}
                </td>
                <td className="num" data-label="Stok minimum">{i.kind === 'SEMI' ? <span className="muted">–</span> : `${i.minStock.toLocaleString('id-ID')} ${i.unit}`}</td>
                <td data-label="Status">{i.active ? 'Aktif' : 'Nonaktif'}</td>
                <td className="row-actions">
                  {i.kind === 'SEMI' ? (
                    <>
                      <button className="secondary" disabled={busy} onClick={() => setBomOf(bomOf === i.id ? null : i.id)}>BOM</button>
                      <button className="secondary" disabled={busy} onClick={() => {
                        const v = window.prompt(`Hasil satu batch ${i.name} (${i.unit}):`, String(i.batchYield ?? ''));
                        if (v) void run(() => manage('PUT', `/v1/ingredients/${i.id}`, { batchYield: Number(v) }));
                      }}>Hasil batch</button>
                    </>
                  ) : (
                    <>
                      <button className="secondary" disabled={busy} onClick={() => {
                        const v = window.prompt(`Stok minimum ${i.name} (${i.unit}); di bawah ini ditandai menipis:`, String(i.minStock));
                        if (v !== null) void run(() => manage('PUT', `/v1/ingredients/${i.id}`, { minStock: Number(v) }));
                      }}>Stok minimum</button>
                      <button className="secondary" disabled={busy} onClick={() => {
                        const v = window.prompt(`Berapa persen ${i.name} yang terpakai setelah susut (kupas, buang tulang)? 100 = tanpa susut:`, String(i.yieldPercent ?? 100));
                        if (v) void run(() => manage('PUT', `/v1/ingredients/${i.id}`, { yieldPercent: Number(v) }));
                      }}>Susut</button>
                    </>
                  )}
                  <button className="secondary" disabled={busy} onClick={() => void run(() => manage('PUT', `/v1/ingredients/${i.id}`, { active: !i.active }))}>{i.active ? 'Nonaktifkan' : 'Aktifkan'}</button>
                </td>
              </tr>,
              ...(bomOf === i.id && i.kind === 'SEMI' ? [
                <tr key={`${i.id}-bom`} className="mod-row"><td colSpan={6}>
                  <BomEditor semi={i} ingredients={ingredients} bom={boms[i.id]} onDone={() => { setBomOf(null); router.refresh(); }} />
                </td></tr>,
              ] : []),
            ])}
            {ingredients.length === 0 && <tr><td colSpan={6} className="muted">Belum ada bahan.</td></tr>}
          </tbody>
        </table>
        <h3>Tambah bahan</h3>
        <form
          className="form-grid"
          onSubmit={async (e) => {
            e.preventDefault();
            const semi = form.kind === 'SEMI';
            const r = await run(() => manage('POST', '/v1/ingredients', { id: form.id, name: form.name, unit: form.unit, kind: form.kind, ...(semi ? { batchYield: Number(form.batchYield) } : { minStock: Number(form.minStock || 0), yieldPercent: Number(form.yieldPercent || 100) }) }));
            if (r) setForm({ id: '', name: '', unit: 'g', minStock: '0', kind: 'RAW', yieldPercent: '100', batchYield: '' });
          }}
        >
          <label>Nama<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} required /></label>
          <label>ID<input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })} maxLength={32} required /></label>
          <label>Satuan
            <select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>
              {Object.entries(UNIT_LABEL).map(([u, l]) => <option key={u} value={u}>{l}</option>)}
            </select>
          </label>
          <label>Jenis
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="RAW">Bahan baku (dibeli, punya stok)</option>
              <option value="SEMI">Setengah jadi (dibuat dari bahan lain)</option>
            </select>
          </label>
          {form.kind === 'SEMI' ? (
            <label>Hasil satu batch ({form.unit})<input inputMode="numeric" value={form.batchYield} onChange={(e) => setForm({ ...form, batchYield: e.target.value.replace(/\D/g, '') })} required /></label>
          ) : (
            <>
              <label>Stok minimum<input inputMode="numeric" value={form.minStock} onChange={(e) => setForm({ ...form, minStock: e.target.value.replace(/\D/g, '') })} /></label>
              <label>Terpakai setelah susut (%)<input inputMode="numeric" value={form.yieldPercent} onChange={(e) => setForm({ ...form, yieldPercent: e.target.value.replace(/\D/g, '') })} /></label>
            </>
          )}
          <div className="form-actions"><button type="submit" disabled={busy}>Tambah</button></div>
        </form>
        <p className="muted small">Satuan dan jenis tidak bisa diubah setelah dibuat (angka stok dan resep akan salah arti). Pakai satuan terkecil: gram, mililiter, atau buah. Bahan setengah jadi (sirup, saus, adonan) tidak punya stok sendiri: pemakaiannya dihitung ke bahan baku penyusunnya. Susut: bila kupasan membuat 80% terpakai, isi 80 dan kebutuhan beli naik otomatis.</p>
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      <section className="panel">
        <h2>Resep per menu</h2>
        <table className="table">
          <thead><tr><th>Menu</th><th>Resep</th><th /></tr></thead>
          <tbody>
            {menu.filter((m) => m.active).flatMap((m) => {
              const r = recipes[m.id];
              const count = Object.keys(r?.base ?? {}).length + Object.values(r?.options ?? {}).reduce((s, o) => s + Object.keys(o).length, 0);
              return [
                <tr key={m.id}>
                  <td data-label="Menu">{m.name}<div className="muted small">{m.category}</div></td>
                  <td data-label="Resep">{count === 0 ? <span className="muted">Belum ada resep</span> : `${count} baris bahan`}</td>
                  <td className="row-actions"><button className="secondary" onClick={() => setEditing(editing === m.id ? null : m.id)}>{count === 0 ? 'Buat resep' : 'Ubah resep'}</button></td>
                </tr>,
                ...(editing === m.id ? [
                  <tr key={`${m.id}-edit`} className="mod-row"><td colSpan={3}>
                    <RecipeEditor menu={m} ingredients={ingredients} recipe={r} onDone={() => { setEditing(null); router.refresh(); }} />
                  </td></tr>,
                ] : []),
              ];
            })}
          </tbody>
        </table>
        <p className="muted small">Menu tanpa resep tidak mengurangi stok apa pun.</p>
      </section>
    </>
  );
}
