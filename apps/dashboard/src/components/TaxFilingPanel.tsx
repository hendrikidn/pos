'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { A1Preview, BpmpPreview, EmployerTaxProfile, Pph21Summary } from '@/lib/api';
import { manage } from '@/lib/manage';
import { rp } from '@/lib/format';

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const NPWP_RE = /^[0-9]{15,16}$/;

interface Props {
  basePath: string;
  year: number;
  month: number;
  employer: EmployerTaxProfile | null;
  bpmp: BpmpPreview;
  a1: A1Preview;
  summary: Pph21Summary;
}

/** Profil pemberi kerja, pratinjau dan unduhan XML Coretax (BPMP bulanan, BPA1 tahunan), dan rekap SPT Masa PPh 21. Hanya owner. */
export function TaxFilingPanel({ basePath, year, month, employer, bpmp, a1, summary }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [f, setF] = useState({
    npwp: employer?.npwp ?? '', tkuSuffix: employer?.tkuSuffix ?? '000000', legalName: employer?.legalName ?? '', address: employer?.address ?? '',
    signerName: employer?.signerName ?? '', signerTitle: employer?.signerTitle ?? '', umkmFinal: employer?.umkmFinal ?? false, taxpayerType: employer?.taxpayerType ?? 'OP',
  });
  const npwpOk = NPWP_RE.test(f.npwp.replace(/[\s.\-]/g, ''));
  const years = [year + 1, year, year - 1, year - 2].filter((y, i, a) => y >= 2024 && a.indexOf(y) === i);
  const href = (y: number, m: number) => `${basePath}&fy=${y}&fm=${m}`;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    const r = await manage('PUT', '/v1/hr/employer-tax', { ...f, npwp: f.npwp.replace(/[\s.\-]/g, ''), address: f.address || undefined, signerName: f.signerName || undefined, signerTitle: f.signerTitle || undefined });
    setBusy(false);
    if (!r.ok) return void setError(r.message);
    setNotice('Profil pemberi kerja disimpan.');
    router.refresh();
  }

  const problems = (p: { problems: string[]; warnings: string[] }) => (
    <>
      {p.problems.length > 0 && <ul className="plain small" role="alert" style={{ color: 'var(--crit)' }}>{p.problems.map((x) => <li key={x}>{x}</li>)}</ul>}
      {p.warnings.length > 0 && <ul className="plain muted small">{p.warnings.map((x) => <li key={x}>{x}</li>)}</ul>}
    </>
  );

  return (
    <>
      <section className="panel">
        <h2>Profil pemberi kerja (pemotong pajak)</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Dipakai pada bukti potong Coretax dan perhitungan PPh Final UMKM. NPWP badan/pemilik 15 atau 16 digit. Kode TKU (6 digit) bawaan 000000 untuk pusat; isi sesuai cabang bila perlu.</p>
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="ok-note" role="status">{notice}</p>}
        <form className="form-grid" onSubmit={save}>
          <label>NPWP pemotong<input inputMode="numeric" value={f.npwp} onChange={(e) => setF({ ...f, npwp: e.target.value.replace(/[^0-9.\- ]/g, '') })} aria-invalid={f.npwp !== '' && !npwpOk} /></label>
          <label>Kode TKU (6 digit)<input inputMode="numeric" maxLength={6} value={f.tkuSuffix} onChange={(e) => setF({ ...f, tkuSuffix: e.target.value.replace(/\D/g, '') })} /></label>
          <label>Nama badan / pemilik<input value={f.legalName} maxLength={120} onChange={(e) => setF({ ...f, legalName: e.target.value })} /></label>
          <label>Alamat<input value={f.address} maxLength={200} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
          <label>Nama penandatangan<input value={f.signerName} maxLength={100} onChange={(e) => setF({ ...f, signerName: e.target.value })} /></label>
          <label>Jabatan penandatangan<input value={f.signerTitle} maxLength={100} onChange={(e) => setF({ ...f, signerTitle: e.target.value })} /></label>
          <label>Jenis wajib pajak
            <select value={f.taxpayerType} onChange={(e) => setF({ ...f, taxpayerType: e.target.value as 'OP' | 'BADAN' })}>
              <option value="OP">Orang pribadi</option>
              <option value="BADAN">Badan (PT/CV)</option>
            </select>
          </label>
          <label className="check-label">PPh Final UMKM 0,5% (PP 55/2022)<input type="checkbox" checked={f.umkmFinal} onChange={(e) => setF({ ...f, umkmFinal: e.target.checked })} /></label>
          <div className="form-actions"><button type="submit" disabled={busy || !npwpOk || f.legalName.trim() === '' || f.tkuSuffix.length !== 6}>Simpan profil</button></div>
        </form>
      </section>

      <section className="panel">
        <h2>Pelaporan PPh 21 ke Coretax</h2>
        <div className="filters">
          <nav className="tabs" aria-label="Tahun pajak">
            {years.map((y) => <Link key={y} className="tab" href={href(y, month)} aria-current={y === year ? 'page' : undefined}>{y}</Link>)}
          </nav>
          <nav className="tabs" aria-label="Masa pajak">
            {MONTHS.map((m, i) => <Link key={m} className="tab" href={href(year, i + 1)} aria-current={i + 1 === month ? 'page' : undefined}>{m.slice(0, 3)}</Link>)}
          </nav>
        </div>

        <h3>Bukti pemotongan masa (BPMP) · {MONTHS[month - 1]} {year}</h3>
        <p className="muted small" style={{ marginTop: 0 }}>Setor paling lambat {bpmp.deadlines.pay}, lapor SPT Masa paling lambat {bpmp.deadlines.file} (periksa ketentuan terbaru).</p>
        {problems(bpmp)}
        <table className="table">
          <thead><tr><th>Pegawai</th><th>PTKP</th><th className="num">Bruto</th><th className="num">Tarif TER</th><th className="num">PPh 21</th></tr></thead>
          <tbody>
            {bpmp.rows.map((r) => <tr key={r.staffId}><td data-label="Pegawai">{r.name}</td><td data-label="PTKP">{r.ptkp}</td><td data-label="Bruto" className="num">{rp(r.gross)}</td><td data-label="Tarif TER" className="num">{r.rate}%</td><td data-label="PPh 21" className="num">{rp(r.tax)}</td></tr>)}
            {bpmp.excluded.map((r) => <tr key={r.staffId}><td data-label="Pegawai">{r.name}</td><td colSpan={4} className="muted">{r.reason}</td></tr>)}
            {bpmp.rows.length === 0 && bpmp.excluded.length === 0 && <tr><td colSpan={5} className="muted">Belum ada penggajian dibayar dengan PPh 21 aktif di bulan ini.</td></tr>}
            {bpmp.rows.length > 0 && <tr><th scope="row" colSpan={2}>Total</th><td className="num"><b>{rp(bpmp.totals.gross)}</b></td><td /><td className="num"><b>{rp(bpmp.totals.tax)}</b></td></tr>}
          </tbody>
        </table>
        <div className="export-links">
          {bpmp.ready
            ? <a className="btn-like" href={`/api/tax-filing?kind=bpmp&year=${year}&month=${month}`} download>Unduh XML BPMP</a>
            : <span className="muted small">XML BPMP baru bisa diunduh setelah data di atas lengkap.</span>}
        </div>

        <h3>Bukti pemotongan A1 (1721-A1) · tahun {year}</h3>
        {problems(a1)}
        <table className="table">
          <thead><tr><th>Pegawai</th><th>Masa</th><th className="num">Gaji</th><th className="num">Tunjangan & lembur</th><th className="num">Iuran pensiun</th><th className="num">PPh 21 dipotong</th></tr></thead>
          <tbody>
            {a1.rows.map((r) => <tr key={r.staffId}><td data-label="Pegawai">{r.name}</td><td data-label="Masa">{MONTHS[r.monthStart - 1]?.slice(0, 3)}–{MONTHS[r.monthEnd - 1]?.slice(0, 3)}</td><td data-label="Gaji" className="num">{rp(r.salary)}</td><td data-label="Tunjangan & lembur" className="num">{rp(r.otherBenefit)}</td><td data-label="Iuran pensiun" className="num">{rp(r.pension)}</td><td data-label="PPh 21 dipotong" className="num">{rp(r.withheld)}</td></tr>)}
            {a1.pending.map((r) => <tr key={r.staffId}><td data-label="Pegawai">{r.name}</td><td colSpan={5} className="muted">belum ada penggajian masa pajak terakhir</td></tr>)}
            {a1.rows.length === 0 && a1.pending.length === 0 && <tr><td colSpan={6} className="muted">Belum ada penggajian dibayar di tahun ini.</td></tr>}
          </tbody>
        </table>
        <div className="export-links">
          {a1.ready
            ? <a className="btn-like" href={`/api/tax-filing?kind=a1&year=${year}`} download>Unduh XML BPA1</a>
            : <span className="muted small">XML BPA1 baru bisa diunduh setelah data di atas lengkap.</span>}
        </div>
        <ul className="plain muted small">{[...bpmp.notes, ...a1.notes].map((n) => <li key={n}>{n}</li>)}</ul>
      </section>

      <section className="panel">
        <h2>Rekap SPT Masa PPh 21 · {year}</h2>
        <table className="table">
          <thead><tr><th>Masa</th><th className="num">Pegawai</th><th className="num">Bruto</th><th className="num">PPh 21</th><th>Setor</th><th>Lapor</th></tr></thead>
          <tbody>
            {summary.months.map((m) => (
              <tr key={m.month}>
                <td data-label="Masa">{MONTHS[m.month - 1]}</td><td data-label="Pegawai" className="num">{m.staff || '–'}</td><td data-label="Bruto" className="num">{m.gross ? rp(m.gross) : '–'}</td>
                <td data-label="PPh 21" className="num">{m.pph21 ? rp(m.pph21) : '–'}</td><td data-label="Setor">{m.deadlines.pay}</td><td data-label="Lapor">{m.deadlines.file}</td>
              </tr>
            ))}
            <tr><th scope="row" colSpan={3}>Total setahun</th><td className="num"><b>{rp(summary.totalPph21)}</b></td><td /><td /></tr>
          </tbody>
        </table>
        <p className="notice">Aplikasi ini menyiapkan data dan berkas impor; <b>tidak</b> menyetor atau melaporkan ke DJP. Penyetoran (kode billing), pengunggahan di Coretax, SPT Tahunan, dan Faktur Pajak (e-Faktur) tetap dilakukan sendiri atau oleh konsultan pajak. Periksa ketentuan dan tarif terbaru sebelum melapor.</p>
      </section>
    </>
  );
}
