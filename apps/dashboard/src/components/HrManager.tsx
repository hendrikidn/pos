'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AttendanceView, PayrollDetail, PayrollRunRow, StaffPayRow } from '@/lib/api';
import { manage } from '@/lib/manage';
import { rp, shortDate } from '@/lib/format';

const hm = (m: number) => `${Math.floor(m / 60)} j ${String(m % 60).padStart(2, '0')} m`;
const clockText = (ms: number) => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
const STATUS = { DRAFT: 'Draf', FINAL: 'Final (belum dibayar)', PAID: 'Dibayar', CANCELED: 'Dibatalkan' } as const;

interface Props {
  view: 'attendance' | 'pay' | 'payroll';
  outletId: string;
  isOwner: boolean;
  attendance: AttendanceView;
  pay: StaffPayRow[];
  runs: PayrollRunRow[];
  details: PayrollDetail[];
}

export function HrManager({ view, outletId, isOwner, attendance, pay, runs, details }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [man, setMan] = useState({ staffId: '', date: new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10), from: '09:00', to: '17:00', reason: '' });
  const [run, setRun] = useState({ from: '', to: '' });
  const [edit, setEdit] = useState<Record<string, { allowance: string; deduction: string }>>({});

  async function act(fn: () => Promise<{ ok: true; data?: unknown } | { ok: false; message: string }>, ok?: (d: unknown) => string) {
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

  if (view === 'pay') {
    return (
      <section className="panel">
        <h2>Tarif gaji</h2>
        <table className="table">
          <thead><tr><th>Staf</th><th>Peran</th><th>Jenis</th><th className="num">Tarif</th><th className="num">Pengali lembur</th><th /></tr></thead>
          <tbody>
            {pay.map((s) => (
              <tr key={s.id} className={s.active ? '' : 'off'}>
                <td data-label="Staf">{s.name}<div className="muted small mono">{s.id}</div></td>
                <td data-label="Peran">{s.role}</td>
                <td data-label="Jenis">{s.payType === 'HOURLY' ? 'Per jam' : s.payType === 'MONTHLY' ? 'Bulanan' : <span className="muted">belum diatur</span>}</td>
                <td data-label="Tarif" className="num">{s.rate !== null ? (s.payType === 'HOURLY' ? `${rp(s.rate)}/jam` : `${rp(s.rate)}/periode`) : '–'}</td>
                <td data-label="Lembur" className="num">{s.overtimeMultiplier ? `${s.overtimeMultiplier}×` : '–'}</td>
                <td className="row-actions">
                  <button className="secondary" disabled={busy} onClick={() => {
                    const type = (window.prompt('Jenis gaji: JAM atau BULAN?', s.payType === 'MONTHLY' ? 'BULAN' : 'JAM') ?? '').trim().toUpperCase();
                    if (!type) return;
                    const rate = window.prompt(type === 'BULAN' ? 'Gaji pokok per periode (rupiah):' : 'Tarif per jam (rupiah):', String(s.rate ?? ''));
                    if (!rate) return;
                    const mult = window.prompt('Pengali lembur (1,0–3,0):', String(s.overtimeMultiplier ?? 1.5));
                    void act(() => manage('PUT', `/v1/hr/pay/${s.id}`, { payType: type === 'BULAN' ? 'MONTHLY' : 'HOURLY', rate: Number(rate), overtimeMultiplier: Number((mult ?? '1.5').replace(',', '.')) }), () => 'Tarif disimpan.');
                  }}>Atur</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small" style={{ marginBottom: 0 }}>Hanya staf yang punya tarif yang ikut penggajian. Lembur = jam kerja per hari di atas batas reguler (bawaan 8 jam). Gaji bulanan: lembur dihitung dari gaji ÷ 173 jam.</p>
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="ok-note" role="status">{notice}</p>}
      </section>
    );
  }

  if (view === 'payroll') {
    const detailOf = new Map(details.map((d) => [d.id, d]));
    return (
      <>
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="ok-note" role="status">{notice}</p>}
        <section className="panel">
          <h2>Penggajian</h2>
          {runs.length === 0 && <p className="muted">Belum ada penggajian untuk outlet ini.</p>}
          {runs.map((r) => {
            const d = detailOf.get(r.id);
            return (
              <div key={r.id} className="journal-entry">
                <header><b>#{r.id}</b> {shortDate(r.from)} – {shortDate(r.to)} · {STATUS[r.status]} · {rp(r.total)} · {r.staff} staf{r.paidDate ? ` · dibayar ${shortDate(r.paidDate)}` : ''}</header>
                {d && (
                  <table className="table">
                    <thead><tr><th>Staf</th><th className="num">Reguler</th><th className="num">Lembur</th><th className="num">Pokok</th><th className="num">Lembur</th><th className="num">Tunjangan</th><th className="num">Potongan</th><th className="num">Bersih</th></tr></thead>
                    <tbody>
                      {d.lines.map((l) => {
                        const e = edit[`${r.id}:${l.staffId}`];
                        return (
                          <tr key={l.staffId}>
                            <td data-label="Staf">{l.name}{l.note && <div className="muted small">{l.note}</div>}</td>
                            <td data-label="Reguler" className="num">{hm(l.regularMinutes)}</td>
                            <td data-label="Jam lembur" className="num">{hm(l.overtimeMinutes)}</td>
                            <td data-label="Pokok" className="num">{rp(l.base)}</td>
                            <td data-label="Upah lembur" className="num">{rp(l.overtimePay)}</td>
                            <td data-label="Tunjangan" className="num">{r.status === 'DRAFT' ? <input aria-label={`Tunjangan ${l.name}`} inputMode="numeric" style={{ width: 100 }} value={e?.allowance ?? String(l.allowance)} onChange={(ev) => setEdit({ ...edit, [`${r.id}:${l.staffId}`]: { allowance: ev.target.value.replace(/\D/g, ''), deduction: e?.deduction ?? String(l.deduction) } })} /> : rp(l.allowance)}</td>
                            <td data-label="Potongan" className="num">{r.status === 'DRAFT' ? <input aria-label={`Potongan ${l.name}`} inputMode="numeric" style={{ width: 100 }} value={e?.deduction ?? String(l.deduction)} onChange={(ev) => setEdit({ ...edit, [`${r.id}:${l.staffId}`]: { allowance: e?.allowance ?? String(l.allowance), deduction: ev.target.value.replace(/\D/g, '') } })} /> : rp(l.deduction)}</td>
                            <td data-label="Bersih" className="num"><b>{rp(l.net)}</b>{e && <button className="secondary" style={{ marginLeft: 8 }} disabled={busy} onClick={() => void act(() => manage('PUT', `/v1/payroll-runs/${r.id}/lines/${l.staffId}`, { allowance: Number(e.allowance || 0), deduction: Number(e.deduction || 0) }), () => 'Slip diperbarui.')}>Simpan</button>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                <p className="actions">
                  <a className="btn-like secondary" href={`/api/payroll-export/${r.id}`} download>Unduh CSV slip</a>
                  {r.status === 'DRAFT' && <button disabled={busy} onClick={() => void act(() => manage('POST', `/v1/payroll-runs/${r.id}/finalize`), () => 'Penggajian difinalkan; angka terkunci.')}>Finalkan</button>}
                  {r.status === 'FINAL' && <button disabled={busy} onClick={() => {
                    const method = (window.prompt('Metode pembayaran (TUNAI atau TRANSFER):', 'TRANSFER') ?? '').trim().toUpperCase();
                    if (method) void act(() => manage('POST', `/v1/payroll-runs/${r.id}/pay`, { method, date: new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10) }), (x) => `Gaji dibayar: ${rp((x as { total: number }).total)}. Jurnal dicatat di Akuntansi.`);
                  }}>Catat pembayaran</button>}
                  {(r.status === 'DRAFT' || r.status === 'FINAL') && <button className="secondary" disabled={busy} onClick={() => { const reason = window.prompt('Alasan membatalkan penggajian:'); if (reason) void act(() => manage('POST', `/v1/payroll-runs/${r.id}/cancel`, { reason })); }}>Batalkan</button>}
                </p>
              </div>
            );
          })}
        </section>
        <section className="panel">
          <h2>Penggajian baru</h2>
          <form className="form-grid" onSubmit={async (e) => { e.preventDefault(); const r = await act(() => manage('POST', `/v1/outlets/${outletId}/payroll-runs`, run), (d) => { const w = (d as { warnings: string[] }).warnings; return `Draf dibuat.${w.length ? ` Perhatian: ${w.join(' ')}` : ''}`; }); if (r) setRun({ from: '', to: '' }); }}>
            <label>Dari tanggal<input type="date" value={run.from} onChange={(e) => setRun({ ...run, from: e.target.value })} required /></label>
            <label>Sampai tanggal<input type="date" value={run.to} onChange={(e) => setRun({ ...run, to: e.target.value })} required /></label>
            <div className="form-actions"><button type="submit" disabled={busy}>Hitung gaji</button></div>
          </form>
          <p className="muted small" style={{ marginBottom: 0 }}>Gaji dihitung dari absensi pada periode (maks. 31 hari). Absen masuk yang tidak pernah ditutup tidak dihitung: koreksi dulu di tab Absensi.</p>
        </section>
      </>
    );
  }

  return (
    <>
      {attendance.open.length > 0 && (
        <section className="panel">
          <h2>Sedang absen masuk</h2>
          <ul className="plain">
            {attendance.open.map((o) => (
              <li key={o.staffId}><b>{o.name}</b> sejak {clockText(o.start)}{o.stale && <span className="delta neg"> · lebih dari 16 jam: kemungkinan lupa absen pulang, koreksi di bawah</span>}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="panel">
        <h2>Absensi</h2>
        <table className="table">
          <thead><tr><th>Staf</th><th className="num">Hari kerja</th><th className="num">Total jam</th></tr></thead>
          <tbody>
            {attendance.summary.map((s) => <tr key={s.staffId}><td data-label="Staf">{s.name}</td><td data-label="Hari" className="num">{s.days}</td><td data-label="Jam" className="num">{hm(s.minutes)}</td></tr>)}
            {attendance.summary.length === 0 && <tr><td colSpan={3} className="muted">Belum ada absensi pada rentang ini. Staf absen lewat tombol &quot;Absen masuk&quot; di aplikasi kasir.</td></tr>}
          </tbody>
        </table>
        <details>
          <summary>Rincian per hari ({attendance.rows.length})</summary>
          <table className="table">
            <thead><tr><th>Staf</th><th>Masuk</th><th>Pulang</th><th className="num">Lama</th><th>Sumber</th></tr></thead>
            <tbody>
              {attendance.rows.map((r, i) => (
                <tr key={i}>
                  <td data-label="Staf">{r.name}</td><td data-label="Masuk">{clockText(r.start)}</td><td data-label="Pulang">{clockText(r.end)}</td>
                  <td data-label="Lama" className="num">{hm(r.minutes)}</td><td data-label="Sumber">{r.manual ? 'Koreksi manual' : r.terminalId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        <p className="muted small" style={{ marginBottom: 0 }}>Transaksi oleh staf yang tidak sedang absen (di luar jam kerja dengan toleransi 15 menit) menjadi temuan di Insiden. Owner dan manager tidak diwajibkan absen.</p>
      </section>

      {attendance.manual.length > 0 && (
        <section className="panel">
          <h2>Koreksi manual</h2>
          <table className="table">
            <thead><tr><th>Staf</th><th>Masuk</th><th>Pulang</th><th>Alasan</th><th /></tr></thead>
            <tbody>
              {attendance.manual.map((m) => (
                <tr key={m.id}>
                  <td data-label="Staf">{attendance.summary.find((s) => s.staffId === m.staffId)?.name ?? m.staffId}</td>
                  <td data-label="Masuk">{clockText(m.start)}</td><td data-label="Pulang">{clockText(m.end)}</td><td data-label="Alasan">{m.reason}<div className="muted small">oleh {m.createdBy}</div></td>
                  <td className="row-actions"><button className="secondary" disabled={busy} onClick={() => { const reason = window.prompt('Alasan membatalkan koreksi:'); if (reason) void act(() => manage('POST', `/v1/outlets/${outletId}/hr/attendance/${m.id}/void`, { reason })); }}>Batalkan</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="panel">
        <h2>Koreksi absen (lupa absen pulang)</h2>
        <form className="form-grid" onSubmit={async (e) => {
          e.preventDefault();
          const at = (t: string) => Date.parse(`${man.date}T${t}:00+07:00`);
          const r = await act(() => manage('POST', `/v1/outlets/${outletId}/hr/attendance`, { staffId: man.staffId, start: at(man.from), end: at(man.to), reason: man.reason }), () => 'Koreksi dicatat.');
          if (r) setMan({ ...man, reason: '' });
        }}>
          <label>Staf
            <select value={man.staffId} onChange={(e) => setMan({ ...man, staffId: e.target.value })} required>
              <option value="">Pilih staf…</option>
              {[...new Map([...attendance.summary, ...attendance.open].map((s) => [s.staffId, s.name])).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          <label>Tanggal<input type="date" value={man.date} onChange={(e) => setMan({ ...man, date: e.target.value })} required /></label>
          <label>Masuk<input type="time" value={man.from} onChange={(e) => setMan({ ...man, from: e.target.value })} required /></label>
          <label>Pulang<input type="time" value={man.to} onChange={(e) => setMan({ ...man, to: e.target.value })} required /></label>
          <label>Alasan<input value={man.reason} onChange={(e) => setMan({ ...man, reason: e.target.value })} maxLength={140} required placeholder="mis. lupa absen pulang" /></label>
          <div className="form-actions"><button type="submit" disabled={busy}>Simpan koreksi</button></div>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="ok-note" role="status">{notice}</p>}
        <p className="muted small" style={{ marginBottom: 0 }}>Koreksi tercatat dengan nama Anda dan alasannya di log audit. Tidak boleh tumpang tindih dengan rentang kerja lain staf itu, maksimal 16 jam.</p>
      </section>
    </>
  );
}
