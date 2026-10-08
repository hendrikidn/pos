'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { JournalView } from '@/lib/api';
import { manage } from '@/lib/manage';
import { rp, shortDate } from '@/lib/format';

const TYPES = [['ASSET', 'Aset'], ['LIABILITY', 'Kewajiban'], ['EQUITY', 'Ekuitas'], ['REVENUE', 'Pendapatan'], ['EXPENSE', 'Beban']] as const;
const emptyLine = () => ({ account: '', debit: '', credit: '' });

export function AccountingManager({ view, outletId, range, canWrite, data }: { view: 'journal' | 'accounts'; outletId: string; range: string; canWrite: boolean; data: JournalView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ date: data.range.to, memo: '' });
  const [lines, setLines] = useState([emptyLine(), emptyLine()]);
  const [acc, setAcc] = useState({ code: '', name: '', type: 'EXPENSE' });
  const names = new Map(data.accounts.map((a) => [a.code, a.name]));
  const active = data.accounts.filter((a) => a.active);

  async function run(fn: () => Promise<{ ok: true } | { ok: false; message: string }>) {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) return void setError(r.message);
    router.refresh();
    return r;
  }

  const totalDebit = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + Number(l.credit || 0), 0);

  async function addEntry(e: React.FormEvent) {
    e.preventDefault();
    const payload = lines.filter((l) => l.account).map((l) => ({ account: l.account, ...(Number(l.debit) > 0 ? { debit: Number(l.debit) } : {}), ...(Number(l.credit) > 0 ? { credit: Number(l.credit) } : {}) }));
    const r = await run(() => manage('POST', `/v1/outlets/${outletId}/accounting/journal`, { date: form.date, memo: form.memo, lines: payload }));
    if (r) { setLines([emptyLine(), emptyLine()]); setForm({ ...form, memo: '' }); }
  }

  if (view === 'accounts') {
    return (
      <>
        <section className="panel">
          <h2>Bagan akun</h2>
          <table className="table">
            <thead><tr><th>Kode</th><th>Nama</th><th>Jenis</th><th>Saldo normal</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data.accounts.map((a) => (
                <tr key={a.code} className={a.active ? '' : 'off'}>
                  <td data-label="Kode" className="mono">{a.code}</td>
                  <td data-label="Nama">{a.name}</td>
                  <td data-label="Jenis">{TYPES.find(([t]) => t === a.type)?.[1]}</td>
                  <td data-label="Saldo normal">{a.normal === 'DEBIT' ? 'Debit' : 'Kredit'}</td>
                  <td data-label="Status">{a.active ? 'Aktif' : 'Nonaktif'}</td>
                  <td className="row-actions">
                    {canWrite && <button className="secondary" disabled={busy} onClick={() => { const v = window.prompt('Nama akun:', a.name); if (v && v.trim()) void run(() => manage('PUT', `/v1/accounting/accounts/${a.code}`, { name: v.trim() })); }}>Ubah nama</button>}
                    {canWrite && <button className="secondary" disabled={busy} onClick={() => void run(() => manage('PUT', `/v1/accounting/accounts/${a.code}`, { active: !a.active }))}>{a.active ? 'Nonaktifkan' : 'Aktifkan'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small" style={{ marginBottom: 0 }}>Akun 1-1100, 1-1200, 2-1200, 4-1000, 4-1100, 4-2000, 4-3000, 4-9000, dan 6-9000 dipakai jurnal otomatis POS dan tidak bisa dinonaktifkan.</p>
        </section>
        {canWrite && (
          <section className="panel">
            <h2>Tambah akun</h2>
            <form className="form-grid" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => manage('POST', '/v1/accounting/accounts', acc)); if (r) setAcc({ code: '', name: '', type: 'EXPENSE' }); }}>
              <label>Kode (mis. 6-5000)<input value={acc.code} onChange={(e) => setAcc({ ...acc, code: e.target.value })} maxLength={6} required /></label>
              <label>Nama<input value={acc.name} onChange={(e) => setAcc({ ...acc, name: e.target.value })} maxLength={80} required /></label>
              <label>Jenis<select value={acc.type} onChange={(e) => setAcc({ ...acc, type: e.target.value })}>{TYPES.map(([t, l]) => <option key={t} value={t}>{l}</option>)}</select></label>
              <div className="form-actions"><button type="submit" disabled={busy}>Tambah</button></div>
            </form>
            {error && <p className="error" role="alert">{error}</p>}
          </section>
        )}
      </>
    );
  }

  return (
    <>
      <section className="panel">
        <h2>Jurnal</h2>
        <p className="export-links no-print">
          <a className="btn-like secondary" href={`/api/export/journal?outlet=${encodeURIComponent(outletId)}&range=${range}`} download>Ekspor CSV jurnal</a>
        </p>
        {data.entries.length === 0 && <p className="muted">Belum ada jurnal pada rentang ini.</p>}
        {data.entries.map((e) => {
          const manual = data.manual.find((m) => m.ref === e.ref);
          return (
            <div key={e.ref} className="journal-entry">
              <header>
                <b>{shortDate(e.date)}</b> <span className="mono">{e.ref}</span> {e.memo}
                {e.source === 'MANUAL' && manual && canWrite && (
                  <button className="secondary" disabled={busy} style={{ marginLeft: 12 }} onClick={() => { const reason = window.prompt('Alasan membatalkan jurnal ini:'); if (reason) void run(() => manage('POST', `/v1/outlets/${outletId}/accounting/journal/${manual.id}/void`, { reason })); }}>Batalkan</button>
                )}
              </header>
              <table className="table">
                <tbody>
                  {e.lines.map((l, i) => (
                    <tr key={i}>
                      <td data-label="Akun" style={{ paddingLeft: l.credit > 0 ? 28 : undefined }}><span className="mono">{l.account}</span> {names.get(l.account)}</td>
                      <td data-label="Debit" className="num">{l.debit ? rp(l.debit) : ''}</td>
                      <td data-label="Kredit" className="num">{l.credit ? rp(l.credit) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {e.notes?.map((n) => <p key={n} className="muted small">Catatan: {n}.</p>)}
            </div>
          );
        })}
        {data.manual.filter((m) => m.voided).length > 0 && (
          <details>
            <summary>Jurnal manual yang dibatalkan ({data.manual.filter((m) => m.voided).length})</summary>
            <ul className="plain">{data.manual.filter((m) => m.voided).map((m) => <li key={m.id}><span className="mono">{m.ref}</span> {m.memo} · {shortDate(m.date)} · alasan: {m.voidReason}</li>)}</ul>
          </details>
        )}
      </section>

      {canWrite && (
        <section className="panel no-print">
          <h2>Jurnal manual</h2>
          <p className="muted small" style={{ marginTop: 0 }}>Untuk biaya dan pencatatan di luar penjualan POS: sewa, gaji, pembelian bahan baku, setoran modal. Total debit harus sama dengan total kredit.</p>
          <form onSubmit={addEntry}>
            <div className="form-grid">
              <label>Tanggal<input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required /></label>
              <label>Keterangan<input value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} maxLength={120} required placeholder="mis. Sewa ruko Oktober" /></label>
            </div>
            <table className="table">
              <thead><tr><th>Akun</th><th className="num">Debit</th><th className="num">Kredit</th><th /></tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td data-label="Akun">
                      <select value={l.account} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, account: e.target.value } : x)))} aria-label={`Akun baris ${i + 1}`}>
                        <option value="">Pilih akun…</option>
                        {active.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                      </select>
                    </td>
                    <td data-label="Debit"><input inputMode="numeric" value={l.debit} aria-label={`Debit baris ${i + 1}`} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, debit: e.target.value.replace(/\D/g, ''), credit: e.target.value ? '' : x.credit } : x)))} /></td>
                    <td data-label="Kredit"><input inputMode="numeric" value={l.credit} aria-label={`Kredit baris ${i + 1}`} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, credit: e.target.value.replace(/\D/g, ''), debit: e.target.value ? '' : x.debit } : x)))} /></td>
                    <td>{lines.length > 2 && <button type="button" className="secondary" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Hapus</button>}</td>
                  </tr>
                ))}
                <tr><td><b>Total</b></td><td className="num"><b>{rp(totalDebit)}</b></td><td className="num"><b>{rp(totalCredit)}</b></td><td /></tr>
              </tbody>
            </table>
            <p className="actions">
              <button type="button" className="secondary" onClick={() => setLines([...lines, emptyLine()])}>+ Baris</button>
              <button type="submit" disabled={busy || totalDebit === 0 || totalDebit !== totalCredit}>Simpan jurnal</button>
              {totalDebit !== totalCredit && <span className="muted small">Selisih {rp(Math.abs(totalDebit - totalCredit))}</span>}
            </p>
          </form>
          {error && <p className="error" role="alert">{error}</p>}
        </section>
      )}
    </>
  );
}
