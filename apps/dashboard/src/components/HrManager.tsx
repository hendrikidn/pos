'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AttendanceView, PayrollDetail, PayrollRunRow, StaffPayRow, StaffTaxRow, TaxSettings } from '@/lib/api';
import { manage } from '@/lib/manage';
import { rp, shortDate } from '@/lib/format';

const PTKP_OPTIONS = ['TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3'] as const;
const hm = (m: number) => `${Math.floor(m / 60)} j ${String(m % 60).padStart(2, '0')} m`;
const clockText = (ms: number) => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
const STATUS = { DRAFT: 'Draf', FINAL: 'Final (belum dibayar)', PAID: 'Dibayar', CANCELED: 'Dibatalkan' } as const;

interface Props {
  view: 'attendance' | 'pay' | 'tax' | 'payroll';
  outletId: string;
  isOwner: boolean;
  attendance: AttendanceView;
  pay: StaffPayRow[];
  runs: PayrollRunRow[];
  details: PayrollDetail[];
  staffTax: StaffTaxRow[];
  taxSettings: TaxSettings | null;
}

const MISSING: Record<string, string> = { NO_CAMERA: 'kamera tidak ada', DENIED: 'kamera ditolak', TIMEOUT: 'kamera lambat', ERROR: 'kamera gagal' };

/** Foto absen kecil; kosong dengan alasannya bila tidak ada. Dimuat lewat proxy dashboard (tidak pernah publik). */
function Shot({ outletId, hash, missing, label }: { outletId: string; hash: string | null; missing: string | null; label: string }) {
  if (hash) {
    const src = `/api/attendance-photo/${encodeURIComponent(outletId)}/${hash}`;
    return <a href={src} target="_blank" rel="noreferrer" title={`${label}: buka foto penuh`}><img src={src} alt={`Foto ${label}`} loading="lazy" width={56} height={42} style={{ objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)', verticalAlign: 'middle' }} /></a>;
  }
  return <span className="muted small" title={label}>{missing ? MISSING[missing] ?? missing : '–'}</span>;
}

export function HrManager({ view, outletId, isOwner, attendance, pay, runs, details, staffTax, taxSettings }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [man, setMan] = useState({ staffId: '', date: new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10), from: '09:00', to: '17:00', reason: '' });
  const [run, setRun] = useState({ from: '', to: '' });
  const [edit, setEdit] = useState<Record<string, { allowance: string; deduction: string }>>({});
  const [taxEdit, setTaxEdit] = useState<Record<string, StaffTaxRow>>({});
  const [cfg, setCfg] = useState<Record<string, string>>({});

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

  if (view === 'tax') {
    const rows = staffTax.map((s) => taxEdit[s.id] ?? s);
    const set = (s: StaffTaxRow, patch: Partial<StaffTaxRow>) => setTaxEdit({ ...taxEdit, [s.id]: { ...(taxEdit[s.id] ?? s), ...patch } });
    // Selalu kirim seluruh profil (termasuk identitas bukti potong): API menimpa baris staf, jadi field yang tidak dikirim akan terhapus.
    const saveTax = (s: StaffTaxRow) => act(
      () => manage('PUT', `/v1/hr/staff-tax/${s.id}`, { taxEnabled: s.taxEnabled, ptkp: s.ptkp, npwp: s.npwp, bpjsTk: s.bpjsTk, bpjsKes: s.bpjsKes, nik: s.nik, position: s.position, foreign: s.foreign, passport: s.foreign ? s.passport : '', annualize: s.annualize }),
      () => { const n = { ...taxEdit }; delete n[s.id]; setTaxEdit(n); return 'Profil disimpan.'; },
    );
    const field = (k: keyof TaxSettings, label: string, unit: string) => taxSettings && (
      <label key={k}>{label} ({unit})<input inputMode="decimal" value={cfg[k] ?? String(taxSettings[k])} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value.replace(/[^0-9.]/g, '') })} /></label>
    );
    return (
      <>
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="ok-note" role="status">{notice}</p>}
        <section className="panel">
          <h2>Profil pajak dan BPJS per staf</h2>
          <p className="muted small" style={{ marginTop: 0 }}>Mati bawaan: penggajian tidak memotong apa pun sampai Anda mengaktifkannya per staf. PPh 21 memakai tarif efektif bulanan (TER) PMK 168/2023, dan penghitungan setahun di masa pajak terakhir (Desember atau saat berhenti bekerja).</p>
          <table className="table">
            <thead><tr><th>Staf</th><th>Hitung PPh 21</th><th>Status PTKP</th><th>NPWP</th><th>BPJS Ketenagakerjaan</th><th>BPJS Kesehatan</th><th /></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td data-label="Staf">{s.name}{!s.active && <span className="muted small"> (nonaktif)</span>}</td>
                  <td data-label="Hitung PPh 21"><input type="checkbox" checked={s.taxEnabled} aria-label={`Hitung PPh 21 ${s.name}`} onChange={(e) => set(s, { taxEnabled: e.target.checked })} /></td>
                  <td data-label="Status PTKP"><select value={s.ptkp} aria-label={`PTKP ${s.name}`} onChange={(e) => set(s, { ptkp: e.target.value as StaffTaxRow['ptkp'] })}>{PTKP_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}</select></td>
                  <td data-label="NPWP"><input type="checkbox" checked={s.npwp} aria-label={`Punya NPWP ${s.name}`} onChange={(e) => set(s, { npwp: e.target.checked })} /></td>
                  <td data-label="BPJS Ketenagakerjaan"><input type="checkbox" checked={s.bpjsTk} aria-label={`BPJS Ketenagakerjaan ${s.name}`} onChange={(e) => set(s, { bpjsTk: e.target.checked })} /></td>
                  <td data-label="BPJS Kesehatan"><input type="checkbox" checked={s.bpjsKes} aria-label={`BPJS Kesehatan ${s.name}`} onChange={(e) => set(s, { bpjsKes: e.target.checked })} /></td>
                  <td className="row-actions">{taxEdit[s.id] && <button disabled={busy} onClick={() => void saveTax(s)}>Simpan</button>}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="muted">Belum ada staf.</td></tr>}
            </tbody>
          </table>
        </section>
        <section className="panel">
          <h2>Identitas untuk bukti potong (Coretax)</h2>
          <p className="muted small" style={{ marginTop: 0 }}>Bukti potong BPMP dan BPA1 memerlukan NIK (16 digit) atau NPWP pegawai. Pegawai asing wajib nomor paspor. Centang &quot;hitung setahun&quot; hanya bila pegawai bekerja sebagian tahun karena status subjek pajak (mis. WNA yang baru tiba atau pergi), bukan untuk karyawan yang sekadar masuk di tengah tahun.</p>
          <table className="table">
            <thead><tr><th>Staf</th><th>NIK / NPWP</th><th>Jabatan</th><th>Warga asing</th><th>Paspor</th><th>Hitung setahun</th><th /></tr></thead>
            <tbody>
              {rows.filter((s) => s.taxEnabled).map((s) => (
                <tr key={s.id}>
                  <td data-label="Staf">{s.name}</td>
                  <td data-label="NIK / NPWP"><input inputMode="numeric" value={s.nik} maxLength={20} aria-label={`NIK atau NPWP ${s.name}`} onChange={(e) => set(s, { nik: e.target.value.replace(/[^0-9.\- ]/g, '') })} />{!/^[0-9]{15,16}$/.test(s.nik.replace(/[\s.\-]/g, '')) && <div className="muted small">belum lengkap</div>}</td>
                  <td data-label="Jabatan"><input value={s.position} maxLength={50} aria-label={`Jabatan ${s.name}`} onChange={(e) => set(s, { position: e.target.value })} /></td>
                  <td data-label="Warga asing"><input type="checkbox" checked={s.foreign} aria-label={`Warga asing ${s.name}`} onChange={(e) => set(s, { foreign: e.target.checked })} /></td>
                  <td data-label="Paspor"><input value={s.passport} disabled={!s.foreign} maxLength={30} aria-label={`Paspor ${s.name}`} onChange={(e) => set(s, { passport: e.target.value.replace(/[^A-Za-z0-9]/g, '') })} /></td>
                  <td data-label="Hitung setahun"><input type="checkbox" checked={s.annualize} aria-label={`Hitung setahun ${s.name}`} onChange={(e) => set(s, { annualize: e.target.checked })} /></td>
                  <td className="row-actions">{taxEdit[s.id] && <button disabled={busy} onClick={() => void saveTax(s)}>Simpan</button>}</td>
                </tr>
              ))}
              {rows.filter((s) => s.taxEnabled).length === 0 && <tr><td colSpan={7} className="muted">Aktifkan &quot;Hitung PPh 21&quot; pada staf di atas lebih dulu.</td></tr>}
            </tbody>
          </table>
        </section>
        {taxSettings && (
          <section className="panel">
            <h2>Tarif dan batas</h2>
            <p className="notice" style={{ marginTop: 0 }}>Periksa tiap awal tahun dan tiap kali aturan berubah. Batas upah Jaminan Pensiun berubah setiap tahun (sejak Maret 2025: Rp10.547.400); nilai bawaan di sini bisa sudah usang. Ini alat bantu hitung, bukan nasihat pajak: konfirmasi ke konsultan pajak sebelum menyetor.</p>
            <form className="form-grid" onSubmit={async (e) => {
              e.preventDefault();
              const body: Record<string, number> = {};
              for (const [k, v] of Object.entries(cfg)) body[k] = Number(v);
              await act(() => manage('PUT', '/v1/hr/tax-settings', body), () => { setCfg({}); return 'Pengaturan disimpan; berlaku untuk penggajian berikutnya.'; });
            }}>
              {field('jpWageCap', 'Batas upah JP', 'Rp')}
              {field('kesWageCap', 'Batas upah Kesehatan', 'Rp')}
              {field('jhtEmployee', 'JHT karyawan', '%')}
              {field('jhtEmployer', 'JHT pemberi kerja', '%')}
              {field('jpEmployee', 'JP karyawan', '%')}
              {field('jpEmployer', 'JP pemberi kerja', '%')}
              {field('jkk', 'JKK (kelompok risiko)', '%')}
              {field('jkm', 'JKM', '%')}
              {field('kesEmployee', 'Kesehatan karyawan', '%')}
              {field('kesEmployer', 'Kesehatan pemberi kerja', '%')}
              {field('biayaJabatanCapMonthly', 'Batas biaya jabatan per bulan', 'Rp')}
              <div className="form-actions"><button type="submit" disabled={busy || Object.keys(cfg).length === 0}>Simpan tarif</button></div>
            </form>
          </section>
        )}
      </>
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
                    <thead><tr><th>Staf</th><th className="num">Reguler</th><th className="num">Lembur</th><th className="num">Pokok</th><th className="num">Lembur</th><th className="num">Tunjangan</th><th className="num">Potongan</th><th className="num">PPh 21</th><th className="num">BPJS karyawan</th><th className="num">Bersih</th></tr></thead>
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
                            <td data-label="PPh 21" className="num">{l.pph21 > 0 ? rp(l.pph21) : '–'}{l.terRate !== null && l.pph21 > 0 && <div className="muted small">TER {l.terCategory} {l.terRate}%</div>}{r.status === 'DRAFT' && l.taxableGross > 0 && <label className="muted small" style={{ display: 'block' }}><input type="checkbox" checked={l.finalPeriod} disabled={busy} onChange={(ev) => void act(() => manage('PUT', `/v1/payroll-runs/${r.id}/lines/${l.staffId}`, { finalPeriod: ev.target.checked }), () => 'Masa pajak diperbarui.')} /> masa pajak terakhir</label>}{l.taxNote && <div className="muted small">{l.taxNote}</div>}</td>
                            <td data-label="BPJS karyawan" className="num">{(() => { const b = l.bpjsEmployee.jht + l.bpjsEmployee.jp + l.bpjsEmployee.kes; return b > 0 ? rp(b) : '–'; })()}</td>
                            <td data-label="Bersih" className="num"><b>{rp(l.net)}</b>{e && <button className="secondary" style={{ marginLeft: 8 }} disabled={busy} onClick={() => void act(() => manage('PUT', `/v1/payroll-runs/${r.id}/lines/${l.staffId}`, { allowance: Number(e.allowance || 0), deduction: Number(e.deduction || 0) }), () => 'Slip diperbarui.')}>Simpan</button>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                <p className="actions">
                  <a className="btn-like secondary" href={`/api/payroll-export/${r.id}`} download>Unduh CSV slip</a>
                  <a className="btn-like secondary" href={`/api/payroll-export/${r.id}?kind=statutory`} download>Unduh CSV potongan (PPh 21, BPJS)</a>
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
              <li key={o.staffId}><b>{o.name}</b> sejak {clockText(o.start)} <Shot outletId={outletId} hash={o.inPhoto} missing={o.inMissing} label="masuk" />{o.stale && <span className="delta neg"> · lebih dari 16 jam: kemungkinan lupa absen pulang, koreksi di bawah</span>}</li>
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
            <thead><tr><th>Staf</th><th>Masuk</th><th>Pulang</th><th className="num">Lama</th><th>Sumber</th><th>Foto masuk</th><th>Foto pulang</th></tr></thead>
            <tbody>
              {attendance.rows.map((r, i) => (
                <tr key={i}>
                  <td data-label="Staf">{r.name}</td><td data-label="Masuk">{clockText(r.start)}</td><td data-label="Pulang">{clockText(r.end)}</td>
                  <td data-label="Lama" className="num">{hm(r.minutes)}</td><td data-label="Sumber">{r.manual ? 'Koreksi manual' : r.terminalId}</td>
                  <td data-label="Foto masuk">{r.manual ? <span className="muted small">–</span> : <Shot outletId={outletId} hash={r.inPhoto} missing={r.inMissing} label="masuk" />}</td>
                  <td data-label="Foto pulang">{r.manual ? <span className="muted small">–</span> : <Shot outletId={outletId} hash={r.outPhoto} missing={r.outMissing} label="pulang" />}</td>
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
