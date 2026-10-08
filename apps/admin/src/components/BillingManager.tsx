'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { BillingOverview } from '@/lib/api';
import { manage } from '@/lib/manage';
import { rupiah } from '@/lib/format';

const STATUS: Record<string, string> = { TRIAL: 'Uji coba', ACTIVE: 'Aktif', DUE: 'Menunggu bayar', OVERDUE: 'Tertunggak', CANCELED: 'Dihentikan' };

export function BillingManager({ overview }: { overview: BillingOverview }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const names = new Map(overview.tenants.map((t) => [t.tenantId, t.tenantName]));

  async function run(path: string, body: unknown, ok: string | ((d: unknown) => string), method: 'POST' | 'PUT' = 'POST') {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await manage(path, body, method);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setNotice(typeof ok === 'function' ? ok(r.data) : ok);
    router.refresh();
  }

  return (
    <>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="ok-note" role="status">{notice}</p>}

      <section className="panel">
        <h2>Tagihan terbuka</h2>
        <p className="actions">
          <button className="secondary" disabled={busy} onClick={() => void run('/v1/admin/billing/run', {}, (d) => `${(d as { issued: number }).issued} tagihan baru diterbitkan.`)}>Jalankan penagihan</button>
          <span className="muted small">Menerbitkan tagihan yang sudah waktunya (7 hari sebelum periode). Owner juga memicunya saat membuka halaman langganan.</span>
        </p>
        <table className="table">
          <thead><tr><th>Faktur</th><th>Tenant</th><th>Periode</th><th className="num">Jumlah</th><th>Jatuh tempo</th><th /></tr></thead>
          <tbody>
            {overview.openInvoices.map((i) => (
              <tr key={i.id}>
                <td data-label="Faktur" className="mono">{i.id}</td>
                <td data-label="Tenant"><Link href={`/tenants/${encodeURIComponent(i.tenantId)}`}>{names.get(i.tenantId) ?? i.tenantId}</Link></td>
                <td data-label="Periode">{i.periodStart} – {i.periodEnd}</td>
                <td data-label="Jumlah" className="num">{rupiah(i.amount)}</td>
                <td data-label="Jatuh tempo">{i.dueDate}</td>
                <td className="row-actions">
                  <button disabled={busy} onClick={() => {
                    const method = window.prompt('Metode pembayaran (TRANSFER, QRIS, TUNAI, LAINNYA):', 'TRANSFER');
                    if (!method) return;
                    const reference = window.prompt('Referensi (nomor transfer, opsional):', '') ?? '';
                    void run(`/v1/admin/billing/invoices/${i.id}/pay`, { method: method.trim().toUpperCase(), reference }, `${i.id} ditandai lunas.`);
                  }}>Tandai lunas</button>
                  <button className="secondary" disabled={busy} onClick={() => {
                    const reason = window.prompt('Alasan membatalkan tagihan ini:');
                    if (reason) void run(`/v1/admin/billing/invoices/${i.id}/void`, { reason }, `${i.id} dibatalkan.`);
                  }}>Batalkan</button>
                </td>
              </tr>
            ))}
            {overview.openInvoices.length === 0 && <tr><td colSpan={6} className="muted">Tidak ada tagihan terbuka.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Langganan tenant</h2>
        <table className="table">
          <thead><tr><th>Tenant</th><th>Paket</th><th>Status</th><th>Uji coba sampai</th><th className="num">Tunggakan</th><th /></tr></thead>
          <tbody>
            {overview.tenants.map((t) => (
              <tr key={t.tenantId} className={t.status === 'CANCELED' ? 'off' : ''}>
                <td data-label="Tenant"><Link href={`/tenants/${encodeURIComponent(t.tenantId)}`}>{t.tenantName}</Link></td>
                <td data-label="Paket">{t.planId}</td>
                <td data-label="Status"><b className={t.status === 'OVERDUE' ? 'neg' : ''}>{STATUS[t.status] ?? t.status}</b></td>
                <td data-label="Uji coba">{t.trialEnd}</td>
                <td data-label="Tunggakan" className="num">{t.outstanding > 0 ? `${rupiah(t.outstanding)} (${t.openInvoices})` : '–'}</td>
                <td className="row-actions">
                  <button className="secondary" disabled={busy} onClick={() => {
                    const d = window.prompt('Uji coba sampai tanggal (YYYY-MM-DD):', t.trialEnd);
                    if (d) void run(`/v1/admin/tenants/${t.tenantId}/subscription`, { trialEnd: d.trim() }, 'Masa uji coba diubah.', 'PUT');
                  }}>Ubah uji coba</button>
                  {t.status === 'CANCELED'
                    ? <button className="secondary" disabled={busy} onClick={() => void run(`/v1/admin/tenants/${t.tenantId}/subscription`, { status: 'TRIAL' }, 'Langganan dihidupkan lagi.', 'PUT')}>Hidupkan lagi</button>
                    : <button className="secondary danger" disabled={busy} onClick={() => { if (window.confirm(`Hentikan langganan ${t.tenantName}? Tidak ada tagihan baru yang terbit.`)) void run(`/v1/admin/tenants/${t.tenantId}/subscription`, { status: 'CANCELED' }, 'Langganan dihentikan.', 'PUT'); }}>Hentikan</button>}
                </td>
              </tr>
            ))}
            {overview.tenants.length === 0 && <tr><td colSpan={6} className="muted">Belum ada tenant dengan langganan.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Harga paket</h2>
        <table className="table">
          <thead><tr><th>Paket</th><th className="num">Per outlet per bulan</th><th /></tr></thead>
          <tbody>
            {overview.plans.map((p) => (
              <tr key={p.id}>
                <td data-label="Paket">{p.name}<div className="muted small mono">{p.id}</div></td>
                <td data-label="Harga" className="num">{rupiah(p.pricePerOutlet)}</td>
                <td className="row-actions">
                  <button className="secondary" disabled={busy} onClick={() => {
                    const v = window.prompt(`Harga baru ${p.name} per outlet per bulan (rupiah):`, String(p.pricePerOutlet));
                    if (v !== null) void run(`/v1/admin/plans/${p.id}`, { pricePerOutlet: Number(v) }, 'Harga diubah. Berlaku untuk tagihan yang terbit berikutnya.', 'PUT');
                  }}>Ubah harga</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small" style={{ marginBottom: 0 }}>Harga awal hanya contoh. Tagihan yang sudah terbit menyimpan harga saat diterbitkan dan tidak ikut berubah.</p>
      </section>
    </>
  );
}
