'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ChannelInboundRow, ChannelIntegrationView, ChannelItemMap, MenuRow, OnlineChannelId } from '@/lib/api';
import { CopyButton } from '@/components/CopyButton';
import { rp } from '@/lib/format';
import { manage } from '@/lib/manage';

const LABEL: Record<OnlineChannelId, string> = { GOFOOD: 'GoFood', GRABFOOD: 'GrabFood', SHOPEEFOOD: 'ShopeeFood' };
const STATUS = { NEW: 'Menunggu kasir', ACCEPTED: 'Diterima', REJECTED: 'Ditolak', CANCELED: 'Dibatalkan platform', EXPIRED: 'Kedaluwarsa' } as const;
const when = (ms: number) => new Date(ms).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Pesanan GoFood, GrabFood, dan ShopeeFood yang masuk langsung ke POS. Owner membuat kunci per kanal (ditampilkan sekali) untuk diberikan ke
 * platform atau perantara resmi yang mengirim pesanan; manager memetakan menu platform ke menu outlet agar kasir bisa menerimanya dengan satu ketukan.
 */
export function ChannelIntegration({ outletId, apiUrl, isOwner, integrations, items, orders, menu }: {
  outletId: string; apiUrl: string; isOwner: boolean; integrations: ChannelIntegrationView[]; items: ChannelItemMap; orders: ChannelInboundRow[]; menu: MenuRow[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ channel: OnlineChannelId; key: string } | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const base = `/v1/outlets/${encodeURIComponent(outletId)}/channel-integrations`;

  async function run(f: () => ReturnType<typeof manage>, after?: (data: unknown) => void) {
    setError(null);
    setBusy(true);
    const r = await f();
    setBusy(false);
    if (!r.ok) return setError(r.message);
    after?.(r.data);
    router.refresh();
  }

  const activeMenu = menu.filter((m) => m.active);
  return (
    <>
      <section className="panel">
        <h2>Terima pesanan langsung</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Pesanan dari platform masuk ke layar kasir tanpa diketik ulang. Platform atau perantara resmi yang memegang akses ke GoFood/GrabFood/ShopeeFood mengirim pesanan
          ke <span className="mono">POST {apiUrl}/v1/public/channel/orders</span> dengan header <span className="mono">Authorization: Bearer &lt;kunci&gt;</span>;
          isinya <span className="mono">ref, total, items[{'{'}externalId?, name, qty, unitPrice, note?{'}'}], customerName?, note?</span>. Kanal juga harus diaktifkan di Pengaturan → Outlet.
        </p>
        {fresh && (
          <div className="panel urgent" role="status">
            <p style={{ marginTop: 0 }}>Kunci {LABEL[fresh.channel]} baru (hanya tampil sekali; yang lama langsung tidak berlaku):</p>
            <p><span className="mono" style={{ wordBreak: 'break-all' }}>{fresh.key}</span> <CopyButton text={fresh.key} /></p>
          </div>
        )}
        <table className="table">
          <thead><tr><th>Platform</th><th>Kunci</th><th>Terima otomatis</th><th /></tr></thead>
          <tbody>
            {integrations.map((i) => (
              <tr key={i.channel}>
                <td data-label="Platform">{LABEL[i.channel]}</td>
                <td data-label="Kunci" className="mono">{i.active ? `${i.keyPrefix}…` : 'belum ada'}</td>
                <td data-label="Terima otomatis">
                  {i.active ? (
                    <label className="field" style={{ margin: 0 }}>
                      <input type="checkbox" checked={i.autoAccept} disabled={busy || !isOwner} onChange={(e) => void run(() => manage('PUT', `${base}/${i.channel}`, { autoAccept: e.target.checked }))} /> {i.autoAccept ? 'Aktif' : 'Mati'}
                    </label>
                  ) : '–'}
                </td>
                <td data-label="">
                  {isOwner ? (
                    <div className="export-links">
                      <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => manage('POST', base, { channel: i.channel }), (d) => setFresh(d as { channel: OnlineChannelId; key: string }))}>{i.active ? 'Ganti kunci' : 'Buat kunci'}</button>
                      {i.active && <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => manage('DELETE', `${base}/${i.channel}`), () => setFresh(null))}>Cabut</button>}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small" style={{ marginBottom: 0 }}>Terima otomatis: pesanan yang semua menunya sudah dipetakan langsung dibuat sebagai order dan dikirim ke dapur oleh terminal yang sedang dipakai kasir.</p>
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      <section className="panel">
        <h2>Pemetaan menu</h2>
        {items.unmapped.length === 0 && items.map.length === 0 && <p className="muted" style={{ margin: 0 }}>Menu platform muncul di sini begitu pesanan pertama masuk; petakan ke menu outlet supaya kasir bisa menerimanya.</p>}
        {items.unmapped.length > 0 && (
          <>
            <p className="notice" style={{ marginTop: 0 }}>Menu ini belum dipetakan, sehingga pesanan yang memuatnya tidak bisa diterima kasir.</p>
            <table className="table">
              <thead><tr><th>Platform</th><th>Menu di platform</th><th className="num">Dipesan</th><th>Menu outlet</th><th /></tr></thead>
              <tbody>
                {items.unmapped.map((u) => {
                  const k = `${u.channel}|${u.key}`;
                  return (
                    <tr key={k}>
                      <td data-label="Platform">{LABEL[u.channel]}</td>
                      <td data-label="Menu di platform">{u.name} <span className="muted small mono">{u.key.startsWith('id:') ? u.key.slice(3) : ''}</span></td>
                      <td data-label="Dipesan" className="num">{u.seen}</td>
                      <td data-label="Menu outlet">
                        <select value={pick[k] ?? ''} onChange={(e) => setPick({ ...pick, [k]: e.target.value })} aria-label={`Menu outlet untuk ${u.name}`}>
                          <option value="">Pilih menu…</option>
                          {activeMenu.map((m) => <option key={m.id} value={m.id}>{m.name} · {rp(m.price)}</option>)}
                        </select>
                      </td>
                      <td data-label=""><button type="button" disabled={busy || !pick[k]} onClick={() => void run(() => manage('PUT', '/v1/channel-items', { channel: u.channel, key: u.key, menuId: pick[k] }))}>Petakan</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
        {items.map.length > 0 && (
          <table className="table">
            <thead><tr><th>Platform</th><th>Menu di platform</th><th>Menu outlet</th><th /></tr></thead>
            <tbody>
              {items.map.map((m) => (
                <tr key={`${m.channel}|${m.key}`}>
                  <td data-label="Platform">{LABEL[m.channel]}</td>
                  <td data-label="Menu di platform" className="mono">{m.key}</td>
                  <td data-label="Menu outlet">{m.menuName ?? m.menuId}</td>
                  <td data-label=""><button type="button" className="secondary" disabled={busy} onClick={() => void run(() => manage('POST', '/v1/channel-items/delete', { channel: m.channel, key: m.key }))}>Hapus</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Pesanan masuk 7 hari terakhir</h2>
        <table className="table">
          <thead><tr><th>Platform</th><th>Nomor</th><th>Masuk</th><th className="num">Nilai</th><th>Status</th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td data-label="Platform">{LABEL[o.channel]}</td>
                <td data-label="Nomor" className="mono">{o.ref}</td>
                <td data-label="Masuk">{when(o.receivedAt)}</td>
                <td data-label="Nilai" className="num">{rp(o.total)}<div className="muted small">{o.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</div></td>
                <td data-label="Status">
                  <b className={o.status === 'NEW' ? 'delta' : o.status === 'ACCEPTED' && !o.canceledByPlatform ? 'delta pos' : 'delta neg'}>{STATUS[o.status]}{o.status === 'ACCEPTED' && o.canceledByPlatform ? ' · dibatalkan platform' : ''}</b>
                  {o.reason && <div className="muted small">{o.reason}</div>}
                </td>
              </tr>
            ))}
            {orders.length === 0 && <tr><td colSpan={5} className="muted">Belum ada pesanan yang masuk lewat integrasi.</td></tr>}
          </tbody>
        </table>
      </section>
    </>
  );
}
