'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { checkPromo, type Promo } from '@pos/order';
import type { Outlet, PromoRow } from '@/lib/api';
import { manage } from '@/lib/manage';
import { rp } from '@/lib/format';

const DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

function describe(p: PromoRow): string {
  const base = p.kind === 'PERCENT' ? `Diskon ${p.value}%${p.maxDiscount ? ` (maks. ${rp(p.maxDiscount)})` : ''}` : `Potong ${rp(p.value)}`;
  const rules = [
    p.minSubtotal ? `belanja min. ${rp(p.minSubtotal)}` : '',
    p.startHour !== undefined && p.endHour !== undefined ? `pukul ${String(p.startHour).padStart(2, '0')}.00–${String(p.endHour).padStart(2, '0')}.00` : '',
    p.days?.length ? p.days.map((d) => DAYS[d]).join(' ') : '',
    p.startDate || p.endDate ? `${p.startDate ?? '…'} s/d ${p.endDate ?? '…'}` : '',
  ].filter(Boolean);
  return [base, ...rules].join(' · ');
}

const EMPTY = { id: '', name: '', kind: 'PERCENT' as 'PERCENT' | 'AMOUNT', value: '', minSubtotal: '', maxDiscount: '', startDate: '', endDate: '', startHour: '', endHour: '', outletId: '' };

export function PromoManager({ promos, outlets }: { promos: PromoRow[]; outlets: Outlet[] }) {
  const router = useRouter();
  const [form, setForm] = useState(EMPTY);
  const [days, setDays] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<{ ok: true } | { ok: false; message: string }>) {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) return void setError(r.message);
    router.refresh();
    return r;
  }

  const num = (s: string): number | undefined => (s.trim() === '' ? undefined : Number(s));
  const outletName = (id: string | null) => (id ? outlets.find((o) => o.id === id)?.name ?? id : 'Semua outlet');

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const body: Partial<Promo> & { outletId?: string } = {
      id: form.id, name: form.name, kind: form.kind, value: Number(form.value),
      ...(num(form.minSubtotal) !== undefined ? { minSubtotal: num(form.minSubtotal) } : {}),
      ...(form.kind === 'PERCENT' && num(form.maxDiscount) !== undefined ? { maxDiscount: num(form.maxDiscount) } : {}),
      ...(days.length > 0 ? { days } : {}),
      ...(form.startDate ? { startDate: form.startDate } : {}), ...(form.endDate ? { endDate: form.endDate } : {}),
      ...(num(form.startHour) !== undefined || num(form.endHour) !== undefined ? { startHour: num(form.startHour), endHour: num(form.endHour) } : {}),
      ...(form.outletId ? { outletId: form.outletId } : {}),
    };
    // Aturan yang sama dengan server, supaya kesalahan terlihat sebelum dikirim.
    const err = checkPromo(body);
    if (err) return setError(err);
    const r = await run(() => manage('POST', '/v1/promos', body));
    if (r) {
      setForm(EMPTY);
      setDays([]);
    }
  }

  return (
    <>
      <section className="panel">
        <h2>Promo</h2>
        <table className="table">
          <thead><tr><th>Promo</th><th>Aturan</th><th>Berlaku di</th><th>Status</th><th /></tr></thead>
          <tbody>
            {promos.map((p) => (
              <tr key={p.id} className={p.active ? '' : 'off'}>
                <td data-label="Promo">{p.name}<div className="muted small mono">{p.id}</div></td>
                <td data-label="Aturan">{describe(p)}</td>
                <td data-label="Berlaku di">{outletName(p.outletId)}</td>
                <td data-label="Status">{p.active ? 'Aktif' : 'Nonaktif'}</td>
                <td className="row-actions">
                  <button className="secondary" disabled={busy} onClick={() => void run(() => manage('PUT', `/v1/promos/${p.id}`, { active: !p.active }))}>
                    {p.active ? 'Nonaktifkan' : 'Aktifkan'}
                  </button>
                </td>
              </tr>
            ))}
            {promos.length === 0 && <tr><td colSpan={5} className="muted">Belum ada promo. Kasir hanya bisa memakai diskon manual.</td></tr>}
          </tbody>
        </table>
        <p className="muted small">
          Kasir memilih promo dari daftar ini; besar potongan ditentukan aturan di sini, bukan diketik kasir. Promo tidak digabung dengan diskon lain dan tidak berlaku untuk makan karyawan.
          Diskon yang memakai promo yang tidak ada di daftar ini, atau yang melebihi aturannya, ditandai sebagai temuan. Promo tidak dihapus agar diskon lama tetap bisa ditelusuri; cukup nonaktifkan.
          Perubahan sampai ke terminal dalam sekitar satu menit.
        </p>
      </section>

      <section className="panel">
        <h2>Tambah promo</h2>
        <form className="form-grid" onSubmit={create}>
          <label>Nama<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={40} required /></label>
          <label>ID<input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })} maxLength={32} required placeholder="happy-hour" /></label>
          <label>Jenis
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'PERCENT' | 'AMOUNT' })}>
              <option value="PERCENT">Persen dari subtotal</option>
              <option value="AMOUNT">Potongan tetap (Rp)</option>
            </select>
          </label>
          <label>{form.kind === 'PERCENT' ? 'Persen (1–100)' : 'Potongan (Rp)'}<input inputMode="numeric" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value.replace(/\D/g, '') })} required /></label>
          {form.kind === 'PERCENT' && (
            <label>Batas potongan (Rp, opsional)<input inputMode="numeric" value={form.maxDiscount} onChange={(e) => setForm({ ...form, maxDiscount: e.target.value.replace(/\D/g, '') })} /></label>
          )}
          <label>Belanja minimum (Rp, opsional)<input inputMode="numeric" value={form.minSubtotal} onChange={(e) => setForm({ ...form, minSubtotal: e.target.value.replace(/\D/g, '') })} /></label>
          <label>Mulai tanggal<input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></label>
          <label>Sampai tanggal<input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></label>
          <label>Dari jam (0–23)<input inputMode="numeric" value={form.startHour} onChange={(e) => setForm({ ...form, startHour: e.target.value.replace(/\D/g, '') })} /></label>
          <label>Sampai jam (1–24)<input inputMode="numeric" value={form.endHour} onChange={(e) => setForm({ ...form, endHour: e.target.value.replace(/\D/g, '') })} /></label>
          <label>Berlaku di
            <select value={form.outletId} onChange={(e) => setForm({ ...form, outletId: e.target.value })}>
              <option value="">Semua outlet</option>
              {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <fieldset className="days">
            <legend>Hari (kosong = setiap hari)</legend>
            {DAYS.map((d, i) => (
              <label key={d} className="check-label">
                <input type="checkbox" checked={days.includes(i)} onChange={(e) => setDays(e.target.checked ? [...days, i].sort() : days.filter((x) => x !== i))} /> {d}
              </label>
            ))}
          </fieldset>
          <div className="form-actions"><button type="submit" disabled={busy}>Tambah</button></div>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
      </section>
    </>
  );
}
