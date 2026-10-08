'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { manage } from '@/lib/manage';

interface Plan { line: number; id: string; action: 'create' | 'update' | 'unchanged'; name: string; changes: string[] }
interface Result { applied: boolean; errors: { line: number; message: string }[]; plan: Plan[]; summary: { create: number; update: number; unchanged: number } }

const TEMPLATE = 'id,nama,kategori,harga,aktif\r\nkopi-susu,Kopi Susu,Kopi,22000,ya\r\n,Nasi Goreng,Makanan,38000,ya\r\n';
const LABEL = { create: 'Baru', update: 'Diubah', unchanged: 'Tak berubah' } as const;

/** Impor menu dari CSV: berkas diperiksa server dulu (tanpa menyimpan), baru diterapkan setelah pemilik melihat rencananya. */
export function MenuImport() {
  const router = useRouter();
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function call(text: string, apply: boolean) {
    setBusy(true);
    setError(null);
    const r = await manage('POST', '/v1/menu/import', { csv: text, apply });
    setBusy(false);
    if (!r.ok) return void setError(r.message);
    return r.data as Result;
  }

  async function pick(file: File | undefined) {
    setResult(null);
    setDone(null);
    if (!file) return;
    if (file.size > 200 * 1024) return setError('Berkas lebih dari 200 KB.');
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    const r = await call(text, false);
    if (r) setResult(r);
  }

  async function apply() {
    if (!csv) return;
    const r = await call(csv, true);
    if (!r) return;
    if (r.applied) {
      setDone(`Impor selesai: ${r.summary.create} baru, ${r.summary.update} diubah, ${r.summary.unchanged} tidak berubah.`);
      setResult(null);
      setCsv(null);
      router.refresh();
    } else setResult(r);
  }

  const changed = result ? result.summary.create + result.summary.update : 0;

  return (
    <section className="panel">
      <h2>Impor menu dari CSV</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Kolom: <b>nama</b>, <b>kategori</b>, <b>harga</b> (wajib), <b>id</b> dan <b>aktif</b> (opsional). Baris dengan id yang sudah ada memperbarui nama, kategori, harga, dan status
        (varian, resep, dan foto tidak berubah); selebihnya menjadi menu baru di semua outlet. Dari Excel: Simpan sebagai CSV. Maksimal 500 baris. Bila ada satu baris salah, tidak ada yang berubah.
      </p>
      <div className="export-links">
        <label className={`btn-like secondary ${busy ? 'disabled' : ''}`}>
          Pilih berkas CSV
          <input type="file" accept=".csv,text/csv,text/plain" hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void pick(f); }} />
        </label>
        <a className="btn-like secondary" href={`data:text/csv;charset=utf-8,${encodeURIComponent(`﻿${TEMPLATE}`)}`} download="templat-menu.csv">Unduh templat</a>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {done && <p className="ok-note" role="status">{done}</p>}
      {result && (
        <>
          <h3>{fileName}</h3>
          {result.errors.length > 0 ? (
            <>
              <p className="error" role="alert">{result.errors.length} kesalahan; tidak ada yang diimpor. Perbaiki berkas lalu pilih lagi.</p>
              <ul className="plain">{result.errors.slice(0, 50).map((e, i) => <li key={i}>Baris {e.line}: {e.message}</li>)}</ul>
              {result.errors.length > 50 && <p className="muted small">…dan {result.errors.length - 50} lainnya.</p>}
            </>
          ) : (
            <>
              <p><b>{result.summary.create}</b> menu baru · <b>{result.summary.update}</b> diubah · {result.summary.unchanged} tidak berubah</p>
              <table className="table">
                <thead><tr><th>Baris</th><th>Menu</th><th>Tindakan</th><th>Perubahan</th></tr></thead>
                <tbody>
                  {result.plan.filter((p) => p.action !== 'unchanged').slice(0, 100).map((p) => (
                    <tr key={p.id}>
                      <td data-label="Baris">{p.line}</td>
                      <td data-label="Menu">{p.name}<div className="muted small mono">{p.id}</div></td>
                      <td data-label="Tindakan">{LABEL[p.action]}</td>
                      <td data-label="Perubahan">{p.changes.join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {changed > 100 && <p className="muted small">Menampilkan 100 dari {changed} perubahan.</p>}
              <p>
                <button disabled={busy || changed === 0} onClick={() => void apply()}>{changed === 0 ? 'Tidak ada perubahan' : `Terapkan ${changed} perubahan`}</button>
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}
