'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { CountRow, StockMovement, StockRow } from '@/lib/api';
import { wibDateTime } from '@/lib/format';
import { manage } from '@/lib/manage';

const STATUS: Record<StockRow['status'], { label: string; cls: string }> = {
  NO_BASELINE: { label: 'Belum dihitung', cls: 'badge' },
  OK: { label: 'Cukup', cls: 'badge badge-LOW' },
  LOW: { label: 'Menipis', cls: 'badge badge-MEDIUM' },
  EMPTY: { label: 'Habis', cls: 'badge badge-CRITICAL' },
};
const KIND_LABEL = { PURCHASE: 'Beli', WASTE: 'Buang', COUNT: 'Hitung' } as const;
const qty = (n: number, unit: string) => `${n.toLocaleString('id-ID')} ${unit}`;
const signed = (n: number, unit: string) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('id-ID')} ${unit}`;

export function StockBoard({ outletId, rows, counts }: { outletId: string; rows: StockRow[]; counts: CountRow[] }) {
  const router = useRouter();
  const [form, setForm] = useState<{ row: StockRow; kind: StockMovement['kind'] } | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  function open(row: StockRow, kind: StockMovement['kind']) {
    setForm({ row, kind });
    setAmount('');
    setNote('');
    setError(null);
    setResult(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setError(null);
    const r = await manage('POST', `/v1/outlets/${encodeURIComponent(outletId)}/stock/movements`, {
      ingredientId: form.row.ingredientId, kind: form.kind, qty: Number(amount), ...(note.trim() ? { note: note.trim() } : {}),
    });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    const m = r.data as StockMovement | null;
    if (form.kind === 'COUNT' && m?.variance != null) {
      setResult(m.variance === 0 ? `${form.row.name}: sesuai perkiraan.` : `${form.row.name}: selisih ${signed(m.variance, form.row.unit)} dari perkiraan ${qty(m.expected ?? 0, form.row.unit)}.`);
    } else setResult(`${KIND_LABEL[form.kind]} ${form.row.name} tercatat.`);
    setForm(null);
    router.refresh();
  }

  return (
    <>
      <section className="panel" aria-labelledby="stok">
        <h2 id="stok">Stok bahan</h2>
        {rows.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Belum ada bahan. Tambahkan di Pengaturan → Bahan &amp; resep.</p>
        ) : (
          <table className="table">
            <thead><tr><th>Bahan</th><th className="num">Perkiraan stok</th><th>Status</th><th className="num">Dipakai sejak hitung terakhir</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ingredientId}>
                  <td data-label="Bahan"><b>{r.name}</b>{r.baseline && <div className="muted small">dihitung {wibDateTime(r.baseline.at)}</div>}</td>
                  <td className="num" data-label="Perkiraan">{r.expected === null ? '—' : qty(r.expected, r.unit)}</td>
                  <td data-label="Status"><span className={STATUS[r.status].cls}>{STATUS[r.status].label}</span>{r.status === 'LOW' && <div className="muted small">min. {qty(r.minStock, r.unit)}</div>}</td>
                  <td className="num" data-label="Dipakai">{r.baseline ? qty(r.used, r.unit) : '—'}</td>
                  <td className="row-actions">
                    <button className="secondary" onClick={() => open(r, 'PURCHASE')}>Beli</button>
                    <button className="secondary" onClick={() => open(r, 'WASTE')}>Buang</button>
                    <button className="secondary" onClick={() => open(r, 'COUNT')}>Hitung</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>
          Perkiraan = hasil hitung terakhir + pembelian − pembuangan − pemakaian dari penjualan menurut resep. Hitung ulang secara berkala: selisihnya menunjukkan bahan yang hilang atau terbuang di luar penjualan.
        </p>
        {result && <p className="ok-note" role="status">{result}</p>}
      </section>

      {form && (
        <section className="panel" aria-labelledby="form-stok">
          <h2 id="form-stok">{KIND_LABEL[form.kind]} · {form.row.name}</h2>
          <form className="form-grid" onSubmit={submit}>
            <label>
              {form.kind === 'COUNT' ? `Hasil hitung fisik (${form.row.unit})` : `Jumlah (${form.row.unit})`}
              <input inputMode="numeric" autoFocus value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} required />
            </label>
            <label>
              {form.kind === 'WASTE' ? 'Alasan (wajib)' : 'Catatan (opsional)'}
              <input value={note} maxLength={140} onChange={(e) => setNote(e.target.value)} required={form.kind === 'WASTE'} placeholder={form.kind === 'WASTE' ? 'mis. tumpah, kedaluwarsa' : form.kind === 'PURCHASE' ? 'mis. nama supplier' : ''} />
            </label>
            <div className="form-actions">
              <button type="button" className="secondary" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" disabled={busy || amount === ''}>Simpan</button>
            </div>
          </form>
          {form.kind === 'COUNT' && form.row.expected !== null && (
            <p className="muted small">Perkiraan sistem saat ini: {qty(form.row.expected, form.row.unit)}. Hitung dulu secara fisik, jangan melihat angka ini terlebih dahulu bila ingin hasil yang jujur.</p>
          )}
          {error && <p className="error" role="alert">{error}</p>}
        </section>
      )}

      <section className="panel" aria-labelledby="opname">
        <h2 id="opname">Riwayat hitung fisik (opname)</h2>
        {counts.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Belum ada hitung fisik. Hitung stok awal setiap bahan dulu supaya perkiraan bisa dibuat.</p>
        ) : (
          <table className="table">
            <thead><tr><th>Waktu</th><th>Bahan</th><th className="num">Dihitung</th><th className="num">Perkiraan</th><th className="num">Selisih</th><th>Oleh</th></tr></thead>
            <tbody>
              {counts.map((c) => (
                <tr key={c.id}>
                  <td data-label="Waktu">{wibDateTime(c.at)}</td>
                  <td data-label="Bahan"><b>{c.name}</b></td>
                  <td className="num" data-label="Dihitung">{qty(c.qty, c.unit)}</td>
                  <td className="num" data-label="Perkiraan">{c.expected === null ? '—' : qty(c.expected, c.unit)}</td>
                  <td className="num" data-label="Selisih">
                    {c.variance === null ? '—' : c.variance === 0 ? 'Pas' : (
                      <span className={c.flagged ? 'badge badge-MEDIUM' : undefined}>{signed(c.variance, c.unit)}{c.flagged && c.variance < 0 ? ' · kurang' : c.flagged ? ' · lebih' : ''}</span>
                    )}
                  </td>
                  <td data-label="Oleh">{c.userId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>Selisih ditandai bila lebih dari 5% pemakaian periode itu. Selisih kurang yang berulang pada bahan yang sama adalah sinyal bahan keluar tanpa penjualan tercatat.</p>
      </section>
    </>
  );
}
