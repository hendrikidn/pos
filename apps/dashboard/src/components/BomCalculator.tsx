'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { BomCalc, BomNode, BomPlan, MenuRow } from '@/lib/api';
import { manage } from '@/lib/manage';
import { rp } from '@/lib/format';

const n = (v: number) => v.toLocaleString('id-ID');
interface Row { menuId: string; qty: string; options: string[] }

function Tree({ nodes, depth = 0 }: { nodes: BomNode[]; depth?: number }) {
  return (
    <ul className="plain" style={{ paddingLeft: depth === 0 ? 0 : 18, margin: '4px 0', listStyle: 'none' }}>
      {nodes.map((x, i) => (
        <li key={`${x.id}-${i}`}>
          <span className={x.kind === 'SEMI' ? '' : 'muted'}>{x.kind === 'SEMI' ? '▸ ' : '· '}{x.name}</span> <b>{n(x.qty)} {x.unit}</b> <span className="muted small">{rp(x.cost)}{x.kind === 'SEMI' ? ' · setengah jadi' : ''}</span>
          {x.children && <Tree nodes={x.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

/** Kalkulator BOM: pilih menu dan jumlah porsi (dengan opsi), lihat kebutuhan bahan baku, biaya, margin, dan kekurangan stok. */
export function BomCalculator({ menu, outletId }: { menu: MenuRow[]; outletId: string | null }) {
  const [rows, setRows] = useState<Row[]>([{ menuId: menu[0]?.id ?? '', qty: '10', options: [] }]);
  const [result, setResult] = useState<BomCalc | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edit = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function calc(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await manage('POST', '/v1/bom/calc', { ...(outletId ? { outletId } : {}), items: rows.filter((x) => x.menuId).map((x) => ({ menuId: x.menuId, qty: Number(x.qty), ...(x.options.length ? { options: x.options } : {}) })) });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setResult(r.data as BomCalc);
  }

  return (
    <>
      <section className="panel">
        <h2>Menu dan jumlah porsi</h2>
        <form onSubmit={calc}>
          {rows.map((r, i) => {
            const m = menu.find((x) => x.id === r.menuId);
            const opts = m?.modifierGroups.flatMap((g) => g.options.map((o) => ({ id: o.id, label: `${g.name}: ${o.name}` }))) ?? [];
            return (
              <div key={i} className="form-grid" style={{ marginBottom: 8, alignItems: 'end' }}>
                <label>Menu
                  <select value={r.menuId} onChange={(e) => edit(i, { menuId: e.target.value, options: [] })}>
                    {menu.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                </label>
                <label>Porsi<input type="number" min={1} max={100000} value={r.qty} onChange={(e) => edit(i, { qty: e.target.value })} required /></label>
                {opts.length > 0 && (
                  <fieldset style={{ border: 0, padding: 0 }}>
                    <legend className="muted small">Opsi (bahan tambahan)</legend>
                    {opts.map((o) => (
                      <label key={o.id} style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                        <input type="checkbox" checked={r.options.includes(o.id)} onChange={(e) => edit(i, { options: e.target.checked ? [...r.options, o.id] : r.options.filter((x) => x !== o.id) })} />{o.label}
                      </label>
                    ))}
                  </fieldset>
                )}
                {rows.length > 1 && <button type="button" className="secondary" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>Hapus</button>}
              </div>
            );
          })}
          <div className="form-actions">
            <button type="button" className="secondary" onClick={() => setRows((rs) => [...rs, { menuId: menu[0]?.id ?? '', qty: '10', options: [] }])}>+ Menu</button>
            <button type="submit" disabled={busy || menu.length === 0}>Hitung</button>
          </div>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        <p className="muted small" style={{ marginBottom: 0 }}>{outletId ? 'Stok dibandingkan dengan perkiraan stok outlet terpilih.' : 'Pilih outlet untuk membandingkan dengan stok.'} Biaya memakai harga pokok rata-rata bahan; opsi menambah bahan tetapi tidak menambah pendapatan.</p>
      </section>

      {result && (
        <>
          <section className="panel">
            <h2>Ringkasan</h2>
            <p>Pendapatan {rp(result.totals.revenue)} · biaya bahan {rp(result.totals.cost)} · margin {rp(result.totals.margin)}{result.totals.marginPct !== null ? ` (${result.totals.marginPct}%)` : ''}</p>
            {result.unpriced.length > 0 && <p className="notice">Bahan berikut belum punya harga pokok, jadi biaya terlalu rendah: {result.unpriced.join(', ')}. Isi lewat pengadaan.</p>}
            {result.noRecipe.length > 0 && <p className="notice">Menu tanpa resep tidak menyumbang kebutuhan: {result.noRecipe.join(', ')}.</p>}
          </section>
          <section className="panel">
            <h2>Kebutuhan bahan baku</h2>
            <table className="table">
              <thead><tr><th>Bahan</th><th className="num">Butuh</th><th className="num">Biaya</th>{result.outletId && <><th className="num">Stok</th><th className="num">Kurang</th></>}</tr></thead>
              <tbody>
                {result.requirements.map((x) => (
                  <tr key={x.ingredientId}>
                    <td data-label="Bahan">{x.name}</td>
                    <td data-label="Butuh" className="num">{n(x.qty)} {x.unit}</td>
                    <td data-label="Biaya" className="num">{rp(x.cost)}</td>
                    {result.outletId && <>
                      <td data-label="Stok" className="num">{x.onHand === null || x.onHand === undefined ? <span className="muted">belum dihitung</span> : `${n(x.onHand)} ${x.unit}`}</td>
                      <td data-label="Kurang" className="num">{x.shortage ? <b className="delta neg">{n(x.shortage)} {x.unit}</b> : '–'}</td>
                    </>}
                  </tr>
                ))}
                {result.requirements.length === 0 && <tr><td colSpan={5} className="muted">Tidak ada kebutuhan: menu belum punya resep.</td></tr>}
              </tbody>
            </table>
            <p className="muted small" style={{ marginBottom: 0 }}>Jumlah yang harus dibeli, sudah termasuk susut bahan dan penguraian bahan setengah jadi, dibulatkan ke atas.</p>
          </section>
          <section className="panel">
            <h2>Uraian per menu</h2>
            {result.lines.map((l, i) => (
              <details key={i} open={result.lines.length === 1}>
                <summary><b>{l.qty}× {l.name}</b>{l.options.length > 0 ? ` (${l.options.join(', ')})` : ''} · biaya {rp(l.cost)}{l.marginPct !== null ? ` · margin ${l.marginPct}%` : ''}</summary>
                {l.tree.length === 0 ? <p className="muted small">Belum ada resep.</p> : <Tree nodes={l.tree} />}
              </details>
            ))}
            <p className="muted small" style={{ marginBottom: 0 }}>▸ = bahan setengah jadi (terurai ke bahan di bawahnya); jumlah pada bahan baku adalah yang terpakai di piring, sebelum susut.</p>
          </section>
        </>
      )}
    </>
  );
}

/** Rencana kebutuhan: pemakaian rata-rata dari riwayat penjualan dikali hari ke depan, dibanding stok. */
export function BomPlanView({ plan, outletName, basePath }: { plan: BomPlan; outletName: string; basePath: string }) {
  const hrefFor = (days: number, history: number) => `${basePath}&days=${days}&history=${history}`;
  return (
    <section className="panel">
      <h2>Rencana kebutuhan · {outletName}</h2>
      <nav className="tabs" aria-label="Hari ke depan">
        {[3, 7, 14, 30].map((d) => <Link key={d} className="tab" href={hrefFor(d, plan.history)} aria-current={d === plan.days ? 'page' : undefined}>{d} hari ke depan</Link>)}
      </nav>
      <nav className="tabs" aria-label="Riwayat">
        {[7, 14, 30].map((h) => <Link key={h} className="tab" href={hrefFor(plan.days, h)} aria-current={h === plan.history ? 'page' : undefined}>riwayat {h} hari</Link>)}
      </nav>
      {plan.activeDays === 0 ? (
        <p className="muted">Belum ada penjualan pada {plan.history} hari terakhir, jadi belum ada yang bisa diperkirakan.</p>
      ) : (
        <>
          <p>Dasar: {plan.orders} order pada {plan.activeDays} hari buka. Perkiraan biaya bahan {plan.days} hari: <b>{rp(plan.totals.cost)}</b>{plan.totals.short > 0 ? <> · <b className="delta neg">{plan.totals.short} bahan diperkirakan kurang</b></> : null}</p>
          <table className="table">
            <thead><tr><th>Bahan</th><th className="num">Butuh {plan.days} hari</th><th className="num">Stok</th><th className="num">Kurang</th><th className="num">Cukup untuk</th><th className="num">Biaya</th></tr></thead>
            <tbody>
              {plan.rows.map((r) => (
                <tr key={r.ingredientId}>
                  <td data-label="Bahan">{r.name}</td>
                  <td data-label="Butuh" className="num">{n(r.need)} {r.unit}</td>
                  <td data-label="Stok" className="num">{r.onHand === null ? <span className="muted">belum dihitung</span> : `${n(r.onHand)} ${r.unit}`}</td>
                  <td data-label="Kurang" className="num">{r.shortage > 0 ? <b className="delta neg">{n(r.shortage)} {r.unit}</b> : '–'}</td>
                  <td data-label="Cukup" className="num">{r.daysOfCover === null ? '–' : `${r.daysOfCover} hari`}</td>
                  <td data-label="Biaya" className="num">{rp(r.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className="muted small" style={{ marginBottom: 0 }}>Rata-rata per hari buka (hari tanpa penjualan tidak dihitung) dari pemakaian teoretis menurut resep. Ini perkiraan sederhana: belum memperhitungkan hari libur, promo, atau musim.</p>
    </section>
  );
}
