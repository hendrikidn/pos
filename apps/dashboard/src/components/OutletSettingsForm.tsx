'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { OutletSettings } from '@/lib/api';
import { manage } from '@/lib/manage';

export function OutletSettingsForm({ s }: { s: OutletSettings }) {
  const router = useRouter();
  const [merchant, setMerchant] = useState(s.merchant_name ?? s.name);
  const [tax, setTax] = useState(String(s.tax_percent));
  const [service, setService] = useState(String(s.service_charge_percent ?? 0));
  const [taxOnService, setTaxOnService] = useState(s.tax_on_service ?? true);
  const [rounding, setRounding] = useState(String(s.rounding_unit ?? 0));
  const [edcs, setEdcs] = useState(s.edcs);
  const [threshold, setThreshold] = useState(String(s.policy?.secondApprovalAbove ?? 50_000));
  const [discount, setDiscount] = useState(String(s.policy?.manualDiscountMaxPercent ?? 15));
  const [mealQuota, setMealQuota] = useState(String(s.policy?.employeeMealQuota ?? 1));
  const [hold, setHold] = useState(String(s.policy?.holdBillMinutes ?? 60));
  const [retention, setRetention] = useState(String(s.cctv_retention_days));
  const [offset, setOffset] = useState(String(s.cctv_clock_offset_sec));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const r = await manage('PUT', `/v1/outlets/${s.id}/settings`, {
      merchantName: merchant, taxPercent: Number(tax), serviceChargePercent: Number(service || 0), taxOnService, roundingUnit: Number(rounding), edcs,
      policy: { secondApprovalAbove: Number(threshold), manualDiscountMaxPercent: Number(discount), employeeMealQuota: Number(mealQuota), holdBillMinutes: Number(hold) },
      cctvRetentionDays: Number(retention), cctvClockOffsetSec: Number(offset),
    });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setSaved(true);
    router.refresh();
  }

  return (
    <form className="panel" onSubmit={save}>
      <h2>Pajak, kebijakan, dan EDC · {s.name}</h2>
      <div className="form-grid">
        <label>Nama merchant (tampil di layar customer)<input value={merchant} onChange={(e) => setMerchant(e.target.value)} maxLength={80} required /></label>
        <label>PBJT / pajak (%)<input inputMode="numeric" value={tax} onChange={(e) => setTax(e.target.value.replace(/\D/g, ''))} required /></label>
        <label>Service charge (%) (0 = tidak ada)<input inputMode="numeric" value={service} onChange={(e) => setService(e.target.value.replace(/\D/g, ''))} /></label>
        <label className="check-label">
          <span>Pajak (PBJT) juga atas service charge</span>
          <input type="checkbox" checked={taxOnService} onChange={(e) => setTaxOnService(e.target.checked)} />
        </label>
        <label>Pembulatan total
          <select value={rounding} onChange={(e) => setRounding(e.target.value)}>
            <option value="0">Tanpa pembulatan</option>
            <option value="100">Ke Rp 100 terdekat</option>
            <option value="500">Ke Rp 500 terdekat</option>
            <option value="1000">Ke Rp 1.000 terdekat</option>
          </select>
        </label>
        <label>Void/refund di atas (Rp) wajib dua persetujuan<input inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value.replace(/\D/g, ''))} required /></label>
        <label>Diskon manual maks. tanpa verifikasi (%)<input inputMode="numeric" value={discount} onChange={(e) => setDiscount(e.target.value.replace(/\D/g, ''))} required /></label>
        <label>Makan karyawan gratis per orang per hari (0 = selalu perlu persetujuan)<input inputMode="numeric" value={mealQuota} onChange={(e) => setMealQuota(e.target.value.replace(/\D/g, ''))} required /></label>
        <label>Bill tunai ditahan lebih dari (menit) wajib alasan (0 = nonaktif)<input inputMode="numeric" value={hold} onChange={(e) => setHold(e.target.value.replace(/\D/g, ''))} required /></label>
        <label>Retensi CCTV (hari)<input inputMode="numeric" value={retention} onChange={(e) => setRetention(e.target.value.replace(/\D/g, ''))} required /></label>
        <label>Selisih jam NVR (detik, + bila NVR lebih cepat)<input inputMode="numeric" value={offset} onChange={(e) => setOffset(e.target.value.replace(/[^0-9-]/g, ''))} /></label>
      </div>

      <h3>Mesin EDC terdaftar</h3>
      <p className="muted small">Hanya mesin ini yang boleh dipilih kasir saat pembayaran kartu atau QRIS. TID ada di slip settlement.</p>
      {edcs.map((d, i) => (
        <div key={i} className="edc-row">
          <input aria-label="TID" placeholder="TID" inputMode="numeric" value={d.tid} onChange={(e) => setEdcs(edcs.map((x, j) => (j === i ? { ...x, tid: e.target.value.replace(/\D/g, '') } : x)))} />
          <input aria-label="Bank" placeholder="Bank" value={d.bank} onChange={(e) => setEdcs(edcs.map((x, j) => (j === i ? { ...x, bank: e.target.value } : x)))} />
          <input aria-label="Label" placeholder="Label" value={d.label} onChange={(e) => setEdcs(edcs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
          <button type="button" className="secondary" onClick={() => setEdcs(edcs.filter((_, j) => j !== i))}>Hapus</button>
        </div>
      ))}
      <p><button type="button" className="secondary" onClick={() => setEdcs([...edcs, { tid: '', bank: '', label: '' }])}>+ Tambah EDC</button></p>

      {error && <p className="error" role="alert">{error}</p>}
      {saved && <p className="ok-note" role="status">Tersimpan. Terminal memperbarui diri dalam sekitar satu menit.</p>}
      <p><button type="submit" disabled={busy}>{busy ? 'Menyimpan…' : 'Simpan'}</button></p>
    </form>
  );
}
