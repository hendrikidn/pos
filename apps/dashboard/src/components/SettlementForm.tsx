'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { manage } from '@/lib/manage';

type Line = { count: string; amount: string };
const blank = (): Line => ({ count: '', amount: '' });
const CHANNELS = [['QRIS', 'QRIS'], ['CARD_CREDIT', 'Kartu kredit'], ['CARD_DEBIT', 'Kartu debit']] as const;

export function SettlementForm({ outletId, edcs }: { outletId: string; edcs: { tid: string; label: string }[] }) {
  const router = useRouter();
  const [tid, setTid] = useState(edcs[0]?.tid ?? '');
  const [batch, setBatch] = useState('');
  const [closedAt, setClosedAt] = useState('');
  const [lines, setLines] = useState<Record<string, Line>>({ QRIS: blank(), CARD_CREDIT: blank(), CARD_DEBIT: blank() });
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (c: string, patch: Partial<Line>) => setLines((l) => ({ ...l, [c]: { ...l[c]!, ...patch } }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    // Isian terstruktur: jam diinput menurut jam slip (WIB). Teks slip: dikirim apa adanya.
    const channels = Object.fromEntries(
      CHANNELS.map(([c]) => [c, { sale: { count: Number(lines[c]!.count || 0), amount: Number(lines[c]!.amount || 0) } }] as const)
        .filter(([, v]) => v.sale.count > 0 || v.sale.amount > 0),
    );
    const body = text.trim()
      ? { text }
      : { slip: { tid, batch, closedAt: closedAt ? `${closedAt}:00+07:00` : '', channels } };
    const r = await manage('POST', `/v1/outlets/${outletId}/settlements`, body);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setNotice('Slip tersimpan dan dicocokkan dengan POS.');
    setText('');
    setBatch('');
    setLines({ QRIS: blank(), CARD_CREDIT: blank(), CARD_DEBIT: blank() });
    router.refresh();
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h2>Masukkan slip settlement</h2>
      <p className="muted small">
        Salin angka dari slip yang dicetak EDC saat tutup batch. Jenis yang tidak ada di slip dikosongkan. Jam mengikuti slip (WIB).
      </p>
      <div className="form-grid">
        <label>Mesin EDC
          <select value={tid} onChange={(e) => setTid(e.target.value)}>
            {edcs.map((d) => <option key={d.tid} value={d.tid}>{d.label} ({d.tid})</option>)}
          </select>
        </label>
        <label>Nomor batch<input inputMode="numeric" value={batch} onChange={(e) => setBatch(e.target.value.replace(/\D/g, ''))} placeholder="000344" /></label>
        <label>Tanggal dan jam tutup<input type="datetime-local" step={1} value={closedAt} onChange={(e) => setClosedAt(e.target.value)} /></label>
      </div>
      <table className="table">
        <thead><tr><th>Jenis</th><th className="num">Jumlah transaksi (SALE)</th><th className="num">Total (Rp)</th></tr></thead>
        <tbody>
          {CHANNELS.map(([c, label]) => (
            <tr key={c}>
              <td data-label="Jenis">{label}</td>
              <td data-label="Jumlah transaksi (SALE)" className="num"><input aria-label={`${label} jumlah`} className="narrow" inputMode="numeric" value={lines[c]!.count} onChange={(e) => set(c, { count: e.target.value.replace(/\D/g, '') })} /></td>
              <td data-label="Total (Rp)" className="num"><input aria-label={`${label} total`} className="narrow" inputMode="numeric" value={lines[c]!.amount} onChange={(e) => set(c, { amount: e.target.value.replace(/\D/g, '') })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <details>
        <summary className="muted small">Atau tempel teks slip lengkap (mengabaikan isian di atas)</summary>
        <textarea className="slip-text" value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder={'TID: ...\nBATCH : ...\n[QRIS]\nSALE 029 RP 770.000'} />
      </details>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="ok-note" role="status">{notice}</p>}
      <p><button type="submit" disabled={busy}>{busy ? 'Menyimpan…' : 'Simpan dan cocokkan'}</button></p>
    </form>
  );
}
