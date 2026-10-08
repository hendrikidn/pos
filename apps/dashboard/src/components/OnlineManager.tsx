'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { OnlineChannelId, OnlineReconciliation } from '@/lib/api';
import { manage } from '@/lib/manage';
import { rp } from '@/lib/format';

const LABEL: Record<OnlineChannelId, string> = { GOFOOD: 'GoFood', GRABFOOD: 'GrabFood', SHOPEEFOOD: 'ShopeeFood' };
const STATUS = { OK: 'Cocok', AMOUNT: 'Nilai berbeda', UNRECORDED: 'Tidak ada di POS' } as const;
const MISSING = { MISSING: 'Tidak ada di laporan platform', NO_REPORT: 'Belum ada laporan untuk tanggal ini' } as const;

interface Result { applied: boolean; errors: { line: number; message: string }[]; rows: number; inserted: number; updated: number }

export function OnlineManager({ outletId, enabled, canUpload, data }: { outletId: string; enabled: OnlineChannelId[]; canUpload: boolean; data: OnlineReconciliation }) {
  const router = useRouter();
  const [channel, setChannel] = useState<OnlineChannelId>(enabled[0] ?? 'GOFOOD');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function pick(file: File | undefined) {
    setError(null);
    setResult(null);
    if (!file) return;
    if (file.size > 1024 * 1024) return setError('Berkas lebih dari 1 MB.');
    setBusy(true);
    const r = await manage('POST', `/v1/outlets/${outletId}/online/reports`, { channel, csv: await file.text(), filename: file.name });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    const out = r.data as Result;
    setResult(out);
    if (out.applied) router.refresh();
  }

  const t = data.totals;
  return (
    <>
      {canUpload && (
        <section className="panel">
          <h2>Unggah laporan platform</h2>
          {enabled.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>Belum ada kanal yang diaktifkan. Aktifkan GoFood, GrabFood, atau ShopeeFood di Pengaturan → Outlet.</p>
          ) : (
            <>
              <p className="muted small" style={{ marginTop: 0 }}>
                Unduh laporan pesanan dari portal merchant platform (CSV), lalu unggah di sini. Kolom yang dikenali: nomor pesanan, tanggal, harga (atau total), komisi, dan dana diterima.
                Setiap pesanan dicocokkan dengan order online di POS; yang tidak cocok muncul sebagai temuan di Insiden.
              </p>
              <div className="export-links">
                <label className="field" style={{ margin: 0 }}>
                  <select value={channel} onChange={(e) => setChannel(e.target.value as OnlineChannelId)} aria-label="Platform">
                    {enabled.map((c) => <option key={c} value={c}>{LABEL[c]}</option>)}
                  </select>
                </label>
                <label className={`btn-like secondary ${busy ? 'disabled' : ''}`}>
                  Pilih berkas CSV
                  <input type="file" accept=".csv,text/csv,text/plain" hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void pick(f); }} />
                </label>
              </div>
            </>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          {result && result.applied && <p className="ok-note" role="status">Laporan masuk: {result.rows} pesanan ({result.inserted} baru, {result.updated} diperbarui).</p>}
          {result && !result.applied && (
            <>
              <p className="error" role="alert">{result.errors.length} kesalahan; tidak ada yang diimpor.</p>
              <ul className="plain">{result.errors.slice(0, 30).map((e, i) => <li key={i}>Baris {e.line}: {e.message}</li>)}</ul>
            </>
          )}
        </section>
      )}

      <div className="tiles">
        <div className="tile"><span>Pesanan di laporan</span><b>{t.orders}</b></div>
        <div className="tile"><span>Penjualan kotor</span><b>{rp(t.gross)}</b></div>
        <div className="tile"><span>Komisi platform</span><b>{rp(t.commission)}</b><small>{t.gross > 0 ? `${Math.round((t.commission / t.gross) * 1000) / 10}% dari penjualan` : ''}</small></div>
        <div className="tile"><span>Dana diterima</span><b>{rp(t.net)}</b></div>
      </div>

      {data.missing.filter((m) => m.status === 'MISSING').length > 0 && (
        <section className="panel urgent">
          <h2>Ada di POS, tidak ada di platform</h2>
          <p style={{ marginTop: 0 }}>Order ini dibayar &quot;Platform&quot; di kasir tetapi tidak ditemukan di laporan platform. Bisa pesanan fiktif untuk menyembunyikan uang tunai: cek dengan kasir dan rekaman CCTV.</p>
          <table className="table">
            <thead><tr><th>Platform</th><th>Nomor</th><th>Tanggal</th><th className="num">Nilai POS</th><th>Kasir</th></tr></thead>
            <tbody>
              {data.missing.filter((m) => m.status === 'MISSING').map((m) => (
                <tr key={m.orderId}><td data-label="Platform">{LABEL[m.channel]}</td><td data-label="Nomor" className="mono">{m.ref}</td><td data-label="Tanggal">{m.date}</td><td data-label="Nilai POS" className="num">{rp(m.amount)}</td><td data-label="Kasir">{m.actorId ?? '–'}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="panel">
        <h2>Pesanan di laporan platform</h2>
        <table className="table">
          <thead><tr><th>Platform</th><th>Nomor</th><th>Tanggal</th><th className="num">Platform</th><th className="num">POS</th><th>Status</th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={`${r.channel}:${r.ref}`}>
                <td data-label="Platform">{LABEL[r.channel]}</td>
                <td data-label="Nomor" className="mono">{r.ref}</td>
                <td data-label="Tanggal">{r.date}</td>
                <td data-label="Platform" className="num">{rp(r.gross)}<div className="muted small">komisi {rp(r.commission)}</div></td>
                <td data-label="POS" className="num">{r.pos ? rp(r.pos.amount) : '–'}</td>
                <td data-label="Status"><b className={r.status === 'OK' ? 'delta pos' : 'delta neg'}>{STATUS[r.status]}</b></td>
              </tr>
            ))}
            {data.rows.length === 0 && <tr><td colSpan={6} className="muted">Belum ada laporan platform pada rentang ini.</td></tr>}
          </tbody>
        </table>
        {data.missing.some((m) => m.status === 'NO_REPORT') && (
          <p className="muted small" style={{ marginBottom: 0 }}>
            {data.missing.filter((m) => m.status === 'NO_REPORT').length} order online di POS berada di tanggal yang belum tercakup laporan ({data.missing.filter((m) => m.status === 'NO_REPORT').map((m) => m.ref).slice(0, 6).join(', ')}…). Unggah laporan yang lebih baru untuk mencocokkannya.
          </p>
        )}
      </section>
    </>
  );
}
