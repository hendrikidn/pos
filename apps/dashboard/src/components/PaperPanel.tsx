'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { PaperRolls } from '@/lib/api';
import { wibDateTime } from '@/lib/format';
import { manage } from '@/lib/manage';

/** Gulungan kertas printer: catat pembelian dan hitung sisa; pemakaian yang jauh di atas jumlah cetakan di POS menjadi temuan (R16). */
export function PaperPanel({ outletId, paper }: { outletId: string; paper: PaperRolls }) {
  const router = useRouter();
  const [kind, setKind] = useState<'PURCHASE' | 'COUNT'>('COUNT');
  const [rolls, setRolls] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="panel">
      <h2>Kertas printer</h2>
      <form className="form-grid" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setError(null);
        const r = await manage('POST', `/v1/outlets/${outletId}/paper-rolls`, { kind, rolls: Number(rolls), ...(note ? { note } : {}) });
        setBusy(false);
        if (!r.ok) return setError(r.message);
        setRolls(''); setNote('');
        router.refresh();
      }}>
        <label>Catatan
          <select value={kind} onChange={(e) => setKind(e.target.value as 'PURCHASE' | 'COUNT')}>
            <option value="COUNT">Hitung sisa gulungan</option>
            <option value="PURCHASE">Beli gulungan baru</option>
          </select>
        </label>
        <label>Jumlah gulungan<input inputMode="numeric" value={rolls} onChange={(e) => setRolls(e.target.value.replace(/\D/g, ''))} required /></label>
        <label>Keterangan<input value={note} maxLength={140} onChange={(e) => setNote(e.target.value)} placeholder="opsional" /></label>
        <div className="form-actions"><button type="submit" disabled={busy || rolls === ''}>Simpan</button></div>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {paper.periods.length > 0 && (
        <table className="table">
          <thead><tr><th>Hitung sisa</th><th className="num">Gulungan terpakai</th><th className="num">Cetakan di POS</th><th className="num">Perkiraan</th><th /></tr></thead>
          <tbody>
            {paper.periods.map((p) => (
              <tr key={p.countId}>
                <td data-label="Hitung sisa">{wibDateTime(p.at)}</td>
                <td data-label="Terpakai" className="num">{p.consumed}</td>
                <td data-label="Cetakan" className="num">{p.documents.toLocaleString('id-ID')}</td>
                <td data-label="Perkiraan" className="num">{p.expected}</td>
                <td>{p.flagged ? <span className="delta neg">jauh di atas perkiraan</span> : <span className="muted">wajar</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small" style={{ marginBottom: 0 }}>Dua kali hitung sisa membentuk satu periode: terpakai = sisa awal + pembelian − sisa akhir. Perkiraan memakai anggapan {paper.assumptions.docCm} cm kertas per cetakan (struk dan tagihan) dan {paper.assumptions.rollMeters} m per gulungan.</p>
    </section>
  );
}
