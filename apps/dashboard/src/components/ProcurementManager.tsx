'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { IngredientCostRow, PayableRow, PoDetail, PoRow, PoStatus, SupplierRow } from '@/lib/api';
import { manage } from '@/lib/manage';
import { rp, shortDate } from '@/lib/format';

const STATUS: Record<PoStatus, string> = { DRAFT: 'Draf', ORDERED: 'Dipesan', PARTIAL: 'Diterima sebagian', RECEIVED: 'Selesai', CANCELED: 'Dibatalkan' };
const cost = (n: number) => `Rp ${n.toLocaleString('id-ID', { maximumFractionDigits: 4 })}`;

interface Props {
  view: 'po' | 'suppliers' | 'payables';
  outletId: string;
  role: string;
  pos: PoRow[];
  suppliers: SupplierRow[];
  payables: PayableRow[];
  ingredients: IngredientCostRow[];
  details: PoDetail[];
}

export function ProcurementManager({ view, outletId, role, pos, suppliers, payables, ingredients, details }: Props) {
  const router = useRouter();
  const canWrite = role === 'OWNER' || role === 'OPS';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sup, setSup] = useState({ id: '', name: '', phone: '' });
  const [po, setPo] = useState({ supplierId: '', expectedDate: '', note: '' });
  const [lines, setLines] = useState([{ ingredientId: '', qty: '', price: '', per: '1' }]);
  const [recv, setRecv] = useState<Record<string, { qty: string; cost: string }>>({});
  const [invoice, setInvoice] = useState<Record<number, string>>({});
  const activeIng = ingredients.filter((i) => i.active);
  const activeSup = suppliers.filter((s) => s.active);

  async function run(fn: () => Promise<{ ok: true; data?: unknown } | { ok: false; message: string }>, ok?: (d: unknown) => string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) return void setError(r.message);
    if (ok) setNotice(ok('data' in r ? r.data : undefined));
    router.refresh();
    return r;
  }

  async function createPo(e: React.FormEvent) {
    e.preventDefault();
    // Harga diisi per kemasan (mis. per kg atau liter): dibagi jumlah satuan terkecil per kemasan.
    const payload = lines.filter((l) => l.ingredientId).map((l) => ({ ingredientId: l.ingredientId, qty: Number(l.qty), unitCost: Math.round((Number(l.price) / Number(l.per || 1)) * 10_000) / 10_000 }));
    const r = await run(() => manage('POST', '/v1/purchase-orders', { outletId, supplierId: po.supplierId, ...(po.expectedDate ? { expectedDate: po.expectedDate } : {}), ...(po.note ? { note: po.note } : {}), lines: payload }), () => 'Pesanan draf dibuat.');
    if (r) { setLines([{ ingredientId: '', qty: '', price: '', per: '1' }]); setPo({ supplierId: '', expectedDate: '', note: '' }); }
  }

  if (view === 'suppliers') {
    return (
      <>
        <section className="panel">
          <h2>Supplier</h2>
          <table className="table">
            <thead><tr><th>Supplier</th><th>Telepon</th><th>Status</th><th /></tr></thead>
            <tbody>
              {suppliers.map((s) => (
                <tr key={s.id} className={s.active ? '' : 'off'}>
                  <td data-label="Supplier">{s.name}<div className="muted small mono">{s.id}</div></td>
                  <td data-label="Telepon">{s.phone ?? '–'}</td>
                  <td data-label="Status">{s.active ? 'Aktif' : 'Nonaktif'}</td>
                  <td className="row-actions">{canWrite && <button className="secondary" disabled={busy} onClick={() => void run(() => manage('PUT', `/v1/suppliers/${s.id}`, { active: !s.active }))}>{s.active ? 'Nonaktifkan' : 'Aktifkan'}</button>}</td>
                </tr>
              ))}
              {suppliers.length === 0 && <tr><td colSpan={4} className="muted">Belum ada supplier.</td></tr>}
            </tbody>
          </table>
        </section>
        {canWrite && (
          <section className="panel">
            <h2>Tambah supplier</h2>
            <form className="form-grid" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => manage('POST', '/v1/suppliers', sup)); if (r) setSup({ id: '', name: '', phone: '' }); }}>
              <label>Nama<input value={sup.name} onChange={(e) => setSup({ ...sup, name: e.target.value })} maxLength={80} required /></label>
              <label>ID<input value={sup.id} onChange={(e) => setSup({ ...sup, id: e.target.value.toLowerCase() })} maxLength={32} required placeholder="sumber-kopi" /></label>
              <label>Telepon<input value={sup.phone} onChange={(e) => setSup({ ...sup, phone: e.target.value })} maxLength={30} /></label>
              <div className="form-actions"><button type="submit" disabled={busy}>Tambah</button></div>
            </form>
            {error && <p className="error" role="alert">{error}</p>}
          </section>
        )}
      </>
    );
  }

  if (view === 'payables') {
    return (
      <section className="panel">
        <h2>Utang supplier</h2>
        <table className="table">
          <thead><tr><th>Supplier</th><th className="num">Ditagih</th><th className="num">Dibayar</th><th className="num">Utang</th><th /></tr></thead>
          <tbody>
            {payables.map((p) => (
              <tr key={p.supplierId}>
                <td data-label="Supplier">{p.name}{p.flaggedReceipts > 0 && <div className="delta neg small">{p.flaggedReceipts} penerimaan dengan harga di atas PO</div>}</td>
                <td data-label="Ditagih" className="num">{rp(p.billed)}</td>
                <td data-label="Dibayar" className="num">{rp(p.paid)}{p.lastPaidDate && <div className="muted small">terakhir {shortDate(p.lastPaidDate)}</div>}</td>
                <td data-label="Utang" className="num"><b>{rp(p.owed)}</b></td>
                <td className="row-actions">
                  {role === 'OWNER' && p.owed > 0 && (
                    <button disabled={busy} onClick={() => {
                      const amount = window.prompt(`Nominal pembayaran ke ${p.name} (maks. ${rp(p.owed)}):`, String(p.owed));
                      if (!amount) return;
                      const method = (window.prompt('Metode (TUNAI atau TRANSFER):', 'TRANSFER') ?? '').trim().toUpperCase();
                      const ref = window.prompt('Referensi (opsional):', '') ?? '';
                      void run(() => manage('POST', `/v1/suppliers/${p.supplierId}/payments`, { amount: Number(amount), method, ref, outletId, date: new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10) }), () => 'Pembayaran dicatat.');
                    }}>Bayar</button>
                  )}
                </td>
              </tr>
            ))}
            {payables.length === 0 && <tr><td colSpan={5} className="muted">Belum ada tagihan supplier.</td></tr>}
          </tbody>
        </table>
        <p className="muted small" style={{ marginBottom: 0 }}>Utang bertambah saat barang diterima dan berkurang saat dibayar. Pembayaran dicatat sebagai jurnal (Dr Utang Usaha, Cr Kas atau Bank) di Akuntansi. Hanya owner yang bisa mencatat pembayaran.</p>
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="ok-note" role="status">{notice}</p>}
      </section>
    );
  }

  const detailOf = new Map(details.map((d) => [d.id, d]));
  return (
    <>
      <section className="panel">
        <h2>Pesanan pembelian</h2>
        {pos.length === 0 && <p className="muted">Belum ada pesanan pembelian untuk outlet ini.</p>}
        {pos.map((p) => {
          const d = detailOf.get(p.id);
          return (
            <div key={p.id} className="journal-entry">
              <header>
                <b>PO-{p.id}</b> {p.supplierName} · {STATUS[p.status]} · {rp(p.total)}
                {p.expectedDate && <span className="muted"> · estimasi {shortDate(p.expectedDate)}</span>}
                {p.receivedAmount > 0 && <span className="muted"> · diterima {rp(p.receivedAmount)}</span>}
              </header>
              {d && (
                <>
                  <table className="table">
                    <thead><tr><th>Bahan</th><th className="num">Pesan</th><th className="num">Harga satuan</th><th className="num">Diterima</th>{(d.status === 'ORDERED' || d.status === 'PARTIAL') && <th className="num">Terima sekarang</th>}</tr></thead>
                    <tbody>
                      {d.lines.map((l) => {
                        const key = `${p.id}:${l.lineNo}`;
                        const rest = l.qty - l.receivedQty;
                        return (
                          <tr key={l.lineNo}>
                            <td data-label="Bahan">{l.name}</td>
                            <td data-label="Pesan" className="num">{l.qty.toLocaleString('id-ID')} {l.unit}</td>
                            <td data-label="Harga" className="num">{cost(l.unitCost)}/{l.unit}</td>
                            <td data-label="Diterima" className="num">{l.receivedQty.toLocaleString('id-ID')}</td>
                            {(d.status === 'ORDERED' || d.status === 'PARTIAL') && (
                              <td data-label="Terima" className="num">
                                {rest > 0 ? (
                                  <span className="export-links" style={{ justifyContent: 'flex-end' }}>
                                    <input aria-label={`Jumlah diterima ${l.name}`} inputMode="numeric" style={{ width: 90 }} placeholder={String(rest)} value={recv[key]?.qty ?? ''} onChange={(e) => setRecv({ ...recv, [key]: { qty: e.target.value.replace(/\D/g, ''), cost: recv[key]?.cost ?? '' } })} />
                                    <input aria-label={`Harga faktur ${l.name}`} inputMode="decimal" style={{ width: 90 }} placeholder={String(l.unitCost)} value={recv[key]?.cost ?? ''} onChange={(e) => setRecv({ ...recv, [key]: { qty: recv[key]?.qty ?? '', cost: e.target.value.replace(/[^0-9.]/g, '') } })} />
                  </span>
                                ) : '✓'}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="actions">
                    {d.status === 'DRAFT' && canWrite && <button disabled={busy} onClick={() => void run(() => manage('POST', `/v1/purchase-orders/${p.id}/order`), () => 'Pesanan dipesan.')}>Pesan ke supplier</button>}
                    {(d.status === 'ORDERED' || d.status === 'PARTIAL') && (
                      <>
                        <input aria-label="Nomor faktur" placeholder="Nomor faktur" value={invoice[p.id] ?? ''} onChange={(e) => setInvoice({ ...invoice, [p.id]: e.target.value })} style={{ maxWidth: 180 }} />
                        <button disabled={busy} onClick={() => {
                          const picked = d.lines.map((l) => ({ lineNo: l.lineNo, rest: l.qty - l.receivedQty, qty: recv[`${p.id}:${l.lineNo}`]?.qty, cost: recv[`${p.id}:${l.lineNo}`]?.cost })).filter((x) => x.rest > 0 && x.qty);
                          if (picked.length === 0) return setError('Isi jumlah yang diterima pada setidaknya satu baris.');
                          void run(() => manage('POST', `/v1/purchase-orders/${p.id}/receive`, { invoiceRef: invoice[p.id] ?? '', lines: picked.map((x) => ({ lineNo: x.lineNo, qty: Number(x.qty), ...(x.cost ? { unitCost: Number(x.cost) } : {}) })) }),
                            (data) => { const r = data as { amount: number; priceFlag: boolean }; return `Barang diterima: ${rp(r.amount)}${r.priceFlag ? '. Perhatian: ada harga faktur di atas harga PO.' : '.'}`; });
                        }}>Terima barang</button>
                      </>
                    )}
                    {canWrite && (d.status === 'DRAFT' || d.status === 'ORDERED') && <button className="secondary" disabled={busy} onClick={() => { const reason = window.prompt('Alasan membatalkan pesanan:'); if (reason) void run(() => manage('POST', `/v1/purchase-orders/${p.id}/cancel`, { reason })); }}>Batalkan</button>}
                  </p>
                </>
              )}
            </div>
          );
        })}
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="ok-note" role="status">{notice}</p>}
      </section>

      {canWrite && (
        <section className="panel">
          <h2>Pesanan baru</h2>
          <form onSubmit={createPo}>
            <div className="form-grid">
              <label>Supplier
                <select value={po.supplierId} onChange={(e) => setPo({ ...po, supplierId: e.target.value })} required>
                  <option value="">Pilih supplier…</option>
                  {activeSup.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label>Estimasi tiba<input type="date" value={po.expectedDate} onChange={(e) => setPo({ ...po, expectedDate: e.target.value })} /></label>
              <label>Catatan<input value={po.note} onChange={(e) => setPo({ ...po, note: e.target.value })} maxLength={200} /></label>
            </div>
            <table className="table">
              <thead><tr><th>Bahan</th><th className="num">Jumlah</th><th className="num">Harga</th><th className="num">per</th><th /></tr></thead>
              <tbody>
                {lines.map((l, i) => {
                  const ing = activeIng.find((x) => x.id === l.ingredientId);
                  return (
                    <tr key={i}>
                      <td data-label="Bahan">
                        <select value={l.ingredientId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, ingredientId: e.target.value } : x)))} aria-label={`Bahan baris ${i + 1}`}>
                          <option value="">Pilih bahan…</option>
                          {activeIng.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.unit}){x.avgCost ? ` · rata-rata ${cost(x.avgCost)}` : ''}</option>)}
                        </select>
                      </td>
                      <td data-label="Jumlah"><input inputMode="numeric" value={l.qty} placeholder={ing ? `dalam ${ing.unit}` : ''} aria-label={`Jumlah baris ${i + 1}`} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/\D/g, '') } : x)))} /></td>
                      <td data-label="Harga"><input inputMode="decimal" value={l.price} aria-label={`Harga baris ${i + 1}`} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, price: e.target.value.replace(/[^0-9.]/g, '') } : x)))} /></td>
                      <td data-label="per"><select value={l.per} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, per: e.target.value } : x)))} aria-label={`Satuan harga baris ${i + 1}`}><option value="1">1 {ing?.unit ?? 'satuan'}</option>{ing && ing.unit !== 'pcs' && <option value="1000">1.000 {ing.unit} (kg/liter)</option>}</select></td>
                      <td>{lines.length > 1 && <button type="button" className="secondary" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Hapus</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="actions">
              <button type="button" className="secondary" onClick={() => setLines([...lines, { ingredientId: '', qty: '', price: '', per: '1' }])}>+ Baris</button>
              <button type="submit" disabled={busy || !po.supplierId}>Simpan draf</button>
            </p>
          </form>
        </section>
      )}
    </>
  );
}
