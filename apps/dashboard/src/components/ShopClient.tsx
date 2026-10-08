'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { rp } from '@/lib/format';

interface Option { id: string; name: string; price: number }
interface Group { id: string; name: string; min: number; max: number; options: Option[] }
interface Item { id: string; name: string; price: number; category: string; modifierGroups: Group[] }
export interface Shop {
  name: string;
  tables: string[];
  menu: Item[];
  pricing: { taxPercent: number; servicePercent: number; taxOnService: boolean; roundingUnit: number };
}
interface Line { item: Item; qty: number; options: Option[]; note: string }

const lineKey = (l: Line) => `${l.item.id}|${l.options.map((o) => o.id).join(',')}|${l.note}`;
const unit = (l: Line) => l.item.price + l.options.reduce((s, o) => s + o.price, 0);

/** Sama dengan perhitungan kasir (computeTotals), supaya perkiraan di layar cocok dengan yang dibayar. */
function estimate(subtotal: number, p: Shop['pricing']): number {
  const service = Math.round((subtotal * p.servicePercent) / 100);
  const tax = Math.round(((subtotal + (p.taxOnService === false ? 0 : service)) * p.taxPercent) / 100);
  const before = subtotal + service + tax;
  return p.roundingUnit > 0 ? Math.round(before / p.roundingUnit) * p.roundingUnit : before;
}

/** Toko web: pilih menu, atur varian, isi nama dan telepon; pesanan menunggu kasir dan dibayar di kasir. */
export function ShopClient({ slug, shop, table }: { slug: string; shop: Shop; table: string }) {
  const router = useRouter();
  const [cart, setCart] = useState<Line[]>([]);
  const [picking, setPicking] = useState<{ item: Item; chosen: Record<string, string[]>; note: string } | null>(null);
  const [type, setType] = useState<'TAKE_AWAY' | 'DINE_IN'>(table ? 'DINE_IN' : 'TAKE_AWAY');
  const [tableNo, setTableNo] = useState(table);
  const [form, setForm] = useState({ name: '', phone: '', note: '', website: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subtotal = cart.reduce((s, l) => s + unit(l) * l.qty, 0);
  const count = cart.reduce((s, l) => s + l.qty, 0);
  const categories = [...new Set(shop.menu.map((m) => m.category))];

  function add(l: Line) {
    setCart((c) => {
      const same = c.find((x) => lineKey(x) === lineKey(l));
      return same ? c.map((x) => (x === same ? { ...x, qty: Math.min(20, x.qty + l.qty) } : x)) : [...c, l];
    });
  }
  function pick(item: Item) {
    if (item.modifierGroups.length === 0) return add({ item, qty: 1, options: [], note: '' });
    setPicking({ item, chosen: Object.fromEntries(item.modifierGroups.map((g) => [g.id, g.min === 1 && g.max === 1 ? [g.options[0]!.id] : []])), note: '' });
  }
  function toggle(g: Group, optId: string) {
    setPicking((p) => {
      if (!p) return p;
      const cur = p.chosen[g.id] ?? [];
      const next = g.min === 1 && g.max === 1 ? [optId] : cur.includes(optId) ? cur.filter((x) => x !== optId) : cur.length < g.max ? [...cur, optId] : cur;
      return { ...p, chosen: { ...p.chosen, [g.id]: next } };
    });
  }
  const pickedOk = picking ? picking.item.modifierGroups.every((g) => (picking.chosen[g.id]?.length ?? 0) >= g.min) : false;
  function confirmPick() {
    if (!picking || !pickedOk) return;
    const options = picking.item.modifierGroups.flatMap((g) => g.options.filter((o) => picking.chosen[g.id]?.includes(o.id)));
    add({ item: picking.item, qty: 1, options, note: picking.note.trim() });
    setPicking(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/shop/${slug}/order`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: form.name, phone: form.phone, type, tableNo: type === 'DINE_IN' ? tableNo : undefined, note: form.note || undefined, website: form.website,
        items: cart.map((l) => ({ itemId: l.item.id, qty: l.qty, options: l.options.map((o) => o.id), note: l.note || undefined })),
      }),
    }).catch(() => null);
    setBusy(false);
    if (!res) return setError('Tidak dapat menghubungi server. Coba lagi.');
    const j = (await res.json().catch(() => ({}))) as { token?: string; message?: string };
    if (!res.ok || !j.token) return setError(j.message ?? 'Pesanan gagal.');
    router.push(`/shop/${slug}/pesanan/${j.token}`);
  }

  return (
    <main className="shop">
      <h1>{shop.name}</h1>
      <p className="muted">Pesan dari sini, bayar di kasir. Kasir akan mengonfirmasi pesanan Anda.</p>
      <div className="shop-seg" role="group" aria-label="Cara menerima pesanan">
        <button type="button" aria-pressed={type === 'TAKE_AWAY'} onClick={() => setType('TAKE_AWAY')}>Ambil sendiri</button>
        <button type="button" aria-pressed={type === 'DINE_IN'} onClick={() => setType('DINE_IN')}>Makan di tempat</button>
      </div>
      {type === 'DINE_IN' && (
        <label className="shop-form">Nomor meja
          {shop.tables.length > 0 ? (
            <select value={tableNo} onChange={(e) => setTableNo(e.target.value)} required>
              <option value="">Pilih meja…</option>
              {shop.tables.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          ) : <input value={tableNo} onChange={(e) => setTableNo(e.target.value)} maxLength={6} required />}
        </label>
      )}

      {categories.map((c) => (
        <section key={c}>
          <h2>{c}</h2>
          {shop.menu.filter((m) => m.category === c).map((m) => (
            <div key={m.id}>
              <div className="shop-item">
                <span><b>{m.name}</b><small>{rp(m.price)}{m.modifierGroups.length > 0 ? ' · pilih varian' : ''}</small></span>
                <button type="button" onClick={() => pick(m)} aria-label={`Tambah ${m.name}`}>Tambah</button>
              </div>
              {picking?.item.id === m.id && (
                <div className="shop-opts">
                  {m.modifierGroups.map((g) => (
                    <fieldset key={g.id}>
                      <legend>{g.name}{g.min > 0 ? ' (wajib)' : g.max > 1 ? ` (maks. ${g.max})` : ''}</legend>
                      {g.options.map((o) => (
                        <label key={o.id}>
                          <input type={g.min === 1 && g.max === 1 ? 'radio' : 'checkbox'} name={g.id} checked={picking.chosen[g.id]?.includes(o.id) ?? false} onChange={() => toggle(g, o.id)} />
                          {o.name}{o.price > 0 ? ` (+${rp(o.price)})` : ''}
                        </label>
                      ))}
                    </fieldset>
                  ))}
                  <input type="text" placeholder="Catatan (opsional)" maxLength={140} value={picking.note} onChange={(e) => setPicking({ ...picking, note: e.target.value })} />
                  <div className="actions" style={{ marginTop: 10 }}>
                    <button type="button" className="secondary" onClick={() => setPicking(null)}>Batal</button>
                    <button type="button" disabled={!pickedOk} onClick={confirmPick}>Masukkan ke keranjang</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </section>
      ))}

      {cart.length > 0 && (
        <form className="shop-form" onSubmit={submit}>
          <h2>Pesanan Anda</h2>
          <ul className="shop-lines">
            {cart.map((l) => (
              <li key={lineKey(l)}>
                <span>{l.item.name}{l.options.length > 0 ? ` (${l.options.map((o) => o.name).join(', ')})` : ''}{l.note ? ` — ${l.note}` : ''}<br /><small className="muted">{rp(unit(l))}</small></span>
                <span className="shop-qty">
                  <button type="button" className="secondary" aria-label="Kurangi" onClick={() => setCart((c) => c.flatMap((x) => (x === l ? (x.qty > 1 ? [{ ...x, qty: x.qty - 1 }] : []) : [x])))}>−</button>
                  {l.qty}
                  <button type="button" className="secondary" aria-label="Tambah" onClick={() => setCart((c) => c.map((x) => (x === l ? { ...x, qty: Math.min(20, x.qty + 1) } : x)))}>+</button>
                </span>
              </li>
            ))}
          </ul>
          <label>Nama<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} minLength={2} maxLength={40} autoComplete="name" required /></label>
          <label>Nomor HP<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" autoComplete="tel" minLength={8} maxLength={20} required /></label>
          <label>Catatan untuk kasir<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={200} placeholder="opsional" /></label>
          <div className="shop-hp" aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} /></label></div>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" disabled={busy || (type === 'DINE_IN' && !tableNo)}>{busy ? 'Mengirim…' : `Kirim pesanan · perkiraan ${rp(estimate(subtotal, shop.pricing))}`}</button>
          <p className="muted small">Harga sudah termasuk pajak{shop.pricing.servicePercent > 0 ? ' dan service' : ''} menurut perkiraan; harga final mengikuti kasir. Pembayaran di kasir.</p>
        </form>
      )}

      {cart.length > 0 && (
        <div className="shop-bar"><div><span>{count} item</span><b>{rp(estimate(subtotal, shop.pricing))}</b></div></div>
      )}
    </main>
  );
}
