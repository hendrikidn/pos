import { useState } from 'react';
import type { OrderRecord } from '@pos/pos-core';
import { HOLD_REASONS } from '@pos/order';
import { Modal } from './dialogs';
import { Qr } from './Qr';
import { CHANNEL_LABEL, METHOD_LABEL, orderLabel, rp, run, type Ctx } from './ui';

type Method = 'CASH' | 'QRIS' | 'EDC_DEBIT' | 'EDC_CREDIT' | 'PLATFORM' | 'DEPOSIT' | 'QR_STATIC';
const METHODS: Method[] = ['CASH', 'QRIS', 'EDC_DEBIT', 'EDC_CREDIT'];

/** Logo sederhana per metode, digambar langsung agar tidak perlu berkas gambar dan tetap tampil saat offline. */
export function MethodIcon({ method }: { method: Method }) {
  const common = { width: 28, height: 28, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (method === 'PLATFORM') {
    return <svg {...common}><rect x="3" y="8" width="13" height="9" rx="1.5" /><path d="M16 11h3l2 2.5V17h-5" /><circle cx="7" cy="18" r="1.8" /><circle cx="17" cy="18" r="1.8" /></svg>;
  }
  if (method === 'DEPOSIT') {
    return <svg {...common}><path d="M6 3.5h12v17l-6-3.5-6 3.5z" /><path d="M9.5 9.5h5M9.5 12.5h5" /></svg>;
  }
  if (method === 'CASH') {
    return <svg {...common}><rect x="2.5" y="6.5" width="19" height="11" rx="2" /><circle cx="12" cy="12" r="2.6" /><path d="M6 9.5v.01M18 14.5v.01" /></svg>;
  }
  if (method === 'QRIS' || method === 'QR_STATIC') {
    return <svg {...common}><rect x="3.5" y="3.5" width="7" height="7" rx="1" /><rect x="13.5" y="3.5" width="7" height="7" rx="1" /><rect x="3.5" y="13.5" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v.01M17 20h3.5M14 20v.01" /></svg>;
  }
  return (
    <svg {...common}>
      <rect x="2.5" y="5" width="19" height="14" rx="2" /><path d="M2.5 10h19M6 15h4" />
      {method === 'EDC_CREDIT' && <path d="M15 15h3" />}
    </svg>
  );
}

export function PayDialog({ ctx, order, onClose }: { ctx: Ctx; order: OrderRecord; onClose: () => void }) {
  const { engine, config } = ctx.rt;
  const totals = engine.totals(order);
  const due = engine.outstanding(order);
  const online = !!order.channel;
  const [method, setMethod] = useState<Method>(online ? 'PLATFORM' : 'CASH');
  const [tendered, setTendered] = useState('');
  const [tid, setTid] = useState(config.edcs[0]?.tid ?? '');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [part, setPart] = useState('');
  const [holdReason, setHoldReason] = useState('');
  /** Kembalian dari pembayaran tunai terakhir; layar sukses tampil setelah tagihan lunas. */
  const [lastChange, setLastChange] = useState(0);
  const [showQr, setShowQr] = useState(false);
  const [reservationId, setReservationId] = useState<number | null>(null);
  // Uang muka reservasi yang tamunya sudah duduk dan masih ada sisanya (dari papan reservasi server); sahnya tetap diperiksa server.
  const deposits = (ctx.rt.reservations()?.items ?? []).filter((r) => r.status === 'SEATED' && r.depositRemaining > 0);
  const picked = deposits.find((r) => r.id === reservationId) ?? null;

  const amount = part === '' ? (method === 'DEPOSIT' && picked ? Math.min(due, picked.depositRemaining) : due) : Number(part);
  const cash = Number(tendered || 0);
  const heldMin = engine.holdRequiredMinutes(order);
  const needReason = method === 'CASH' && heldMin !== null;
  const amountOk = Number.isInteger(amount) && amount > 0 && amount <= due && (method !== 'DEPOSIT' || (picked !== null && amount <= picked.depositRemaining));
  const partial = amountOk && amount < due;
  const change = method === 'CASH' && amountOk && cash > amount ? cash - amount : 0;
  const quick = [...new Set([amount, Math.ceil(amount / 10_000) * 10_000, Math.ceil(amount / 50_000) * 50_000, 100_000])].filter((n) => n >= amount && n > 0);
  const settled = due === 0 && order.payments.length > 0;
  const digitalOk = ctx.rt.receiptUrl('x') !== null;
  const paidSoFar = totals.total - due;

  async function submit() {
    setBusy(true);
    const r = await engine.pay(order.id, {
      method,
      amount,
      ...(needReason ? { holdReason } : {}),
      ...(method === 'CASH' ? { tendered: cash || amount } : method === 'DEPOSIT' ? { reservationId: reservationId! } : method === 'QR_STATIC' ? {} : { tid, approvalCode: code.trim() || undefined }),
    });
    setBusy(false);
    ctx.bump();
    if (!r.ok) return ctx.toast(r.message, 'error');
    setLastChange(r.value.change);
    setTendered('');
    setCode('');
    setPart('');
    const left = engine.outstanding(r.value.order);
    if (left > 0) ctx.toast(`Tercatat. Sisa tagihan ${rp(left)}`, 'info');
  }

  if (settled) {
    const qrUrl = order.receiptToken ? ctx.rt.receiptUrl(order.receiptToken) : null;
    return (
      <Modal title="Pembayaran berhasil" onClose={onClose} wide>
        <div className="pay-done">
          <div className="pay-done-mark" aria-hidden>✓</div>
          <p className="pay-done-total">{rp(totals.total)}</p>
          {lastChange > 0 ? (
            <p className="change big">Kembalian {rp(lastChange)}</p>
          ) : (
            <p className="muted">Lunas, tidak ada kembalian.</p>
          )}
          {order.member && config.loyalty && (
            <p className="muted">Member {order.member.name}: +{Math.floor(order.payments.reduce((s, p) => s + p.amount, 0) / config.loyalty.rupiahPerPoint)} poin dari order ini</p>
          )}
          <ul className="pay-list" aria-label="Pembayaran">
            {order.payments.map((p, i) => (
              <li key={i}><MethodIcon method={p.method} /><span>{METHOD_LABEL[p.method]}</span><b>{rp(p.amount)}</b></li>
            ))}
          </ul>
          {showQr && qrUrl && <Qr value={qrUrl} size={200} label="Kode QR struk digital" />}
          <div className="actions wrap">
            <button className="secondary" onClick={() => void run(ctx, () => engine.printReceipt(order.id))}>Cetak struk</button>
            {digitalOk && (
              <button className="secondary" onClick={() => void run(ctx, () => engine.digitalReceipt(order.id)).then((r) => r.ok && setShowQr(true))}>
                Bagikan struk (QR)
              </button>
            )}
            <button onClick={onClose}>Selesai</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Pembayaran · ${orderLabel(order, config.staff)}`} onClose={onClose} wide>
      <div className="pay-figures">
        <div><span>Total Tagihan</span><b>{rp(totals.total)}</b></div>
        <div className="due"><span>Sisa Tagihan</span><b>{rp(due)}</b></div>
        <div className={change > 0 ? 'chg on' : 'chg'}><span>Kembalian</span><b>{rp(change)}</b></div>
      </div>

      <div className="pay-body">
        <nav className="pay-methods" aria-label="Metode pembayaran">
          {(online ? (['PLATFORM'] as Method[]) : [...METHODS, ...(config.staticQr ? (['QR_STATIC'] as Method[]) : []), ...(deposits.length > 0 ? (['DEPOSIT'] as Method[]) : [])]).map((m) => (
            <button key={m} type="button" className={method === m ? 'on' : ''} aria-pressed={method === m} onClick={() => setMethod(m)}>
              <MethodIcon method={m} />
              <span>{METHOD_LABEL[m]}</span>
            </button>
          ))}
        </nav>

        <div className="pay-main">
          {order.payments.length > 0 && (
            <ul className="pay-list" aria-label="Pembayaran sebelumnya">
              {order.payments.map((p, i) => (
                <li key={i}><MethodIcon method={p.method} /><span>{METHOD_LABEL[p.method]}</span><b>{rp(p.amount)}</b></li>
              ))}
              <li className="sum"><span>Sudah dibayar</span><b>{rp(paidSoFar)}</b></li>
            </ul>
          )}

          {online ? (
            <p className="notice">Pesanan {CHANNEL_LABEL[order.channel!.channel]} nomor <b>{order.channel!.ref}</b> dibayar oleh platform sebesar seluruh tagihan. Pastikan pesanan ini memang ada di aplikasi {CHANNEL_LABEL[order.channel!.channel]}: pesanan fiktif ditandai saat rekonsiliasi.</p>
          ) : (
            <>
              <label className="field">Nominal yang dibayar sekarang
                <input inputMode="numeric" value={part} onChange={(e) => setPart(e.target.value.replace(/\D/g, ''))} placeholder={String(due)} />
              </label>
              <div className="quick" aria-label="Bagi rata">
                <button type="button" className="secondary" onClick={() => setPart('')}>Penuh</button>
                {[2, 3, 4].map((n) => (
                  <button key={n} type="button" className="secondary" onClick={() => setPart(String(Math.min(due, Math.ceil(due / n))))}>Bagi {n}</button>
                ))}
              </div>
              {partial && <p className="notice">Pembayaran sebagian. Sisa {rp(due - amount)} dibayar kemudian (metode boleh berbeda).</p>}
            </>
          )}

          {method === 'PLATFORM' ? null : method === 'QR_STATIC' ? (
            <p className="notice">QR statis tidak bisa dicocokkan dengan bank secara otomatis, dan setiap pemakaiannya dicatat untuk ditinjau owner. Pakai EDC atau QR dinamis bila tersedia. Pastikan stiker QR di meja kasir atas nama <b>{config.merchantName}</b>.</p>
          ) : method === 'DEPOSIT' ? (
            <fieldset className="opt-group">
              <legend>Reservasi yang uang mukanya dipakai</legend>
              <div className="opts">
                {deposits.map((r) => (
                  <button key={r.id} type="button" role="radio" aria-checked={reservationId === r.id} className={`opt ${reservationId === r.id ? 'on' : ''}`} onClick={() => setReservationId(r.id)}>
                    <span>{r.guestName} · {rp(r.depositRemaining)}</span>
                  </button>
                ))}
              </div>
              <p className="muted">Uang muka dicocokkan dengan catatan reservasi di server; pemakaian di luar yang tercatat menjadi temuan.</p>
            </fieldset>
          ) : method === 'CASH' ? (
            <>
              {needReason && (
                <fieldset className="opt-group">
                  <legend>Bill sudah ditahan {heldMin} menit<small className={holdReason ? '' : 'need'}>Wajib pilih alasan</small></legend>
                  <div className="opts">
                    {HOLD_REASONS.map((r) => (
                      <button key={r.code} type="button" role="radio" aria-checked={holdReason === r.code} className={`opt ${holdReason === r.code ? 'on' : ''}`} onClick={() => setHoldReason(r.code)}>
                        <span>{r.label}</span>
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
              <label className="field">Uang diterima
                <input inputMode="numeric" value={tendered} onChange={(e) => setTendered(e.target.value.replace(/\D/g, ''))} placeholder={String(amount)} />
              </label>
              <div className="quick">
                {quick.map((n) => (
                  <button key={n} type="button" className="secondary" onClick={() => setTendered(String(n))}>{n === amount ? 'Uang pas' : rp(n)}</button>
                ))}
              </div>
            </>
          ) : (
            <>
              <p className="notice">
                Pastikan nama merchant di mesin atau QR tertulis <b>{config.merchantName}</b>. Jangan terima pembayaran ke QR atau mesin lain.
              </p>
              {config.edcs.length > 1 && (
                <label className="field">Mesin EDC
                  <select value={tid} onChange={(e) => setTid(e.target.value)}>
                    {config.edcs.map((e) => <option key={e.tid} value={e.tid}>{e.label} ({e.tid})</option>)}
                  </select>
                </label>
              )}
              <label className="field">Kode approval pada slip (opsional)
                <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              </label>
            </>
          )}

          <dl className="totals pay-summary">
            <div><dt>Subtotal</dt><dd>{rp(totals.subtotal)}</dd></div>
            {totals.discount > 0 && <div><dt>Diskon{order.promoId ? ` · ${config.promos?.find((p) => p.id === order.promoId)?.name ?? order.promoId}` : ''}</dt><dd>−{rp(totals.discount)}</dd></div>}
            {totals.service > 0 && <div><dt>Service {config.serviceChargePercent}%</dt><dd>{rp(totals.service)}</dd></div>}
            {totals.tax > 0 && <div><dt>PBJT {config.taxPercent}%</dt><dd>{rp(totals.tax)}</dd></div>}
            {totals.rounding !== 0 && <div><dt>Pembulatan</dt><dd>{totals.rounding < 0 ? '−' : ''}{rp(Math.abs(totals.rounding))}</dd></div>}
            <div className="grand"><dt>Total</dt><dd>{rp(totals.total)}</dd></div>
          </dl>
        </div>
      </div>

      <div className="actions">
        <button className="secondary" onClick={onClose}>Batal</button>
        <button
          disabled={busy || !amountOk || (needReason && !holdReason) || (method === 'CASH' && cash > 0 && cash < amount)}
          onClick={submit}
        >
          {method === 'PLATFORM' ? 'Catat dibayar platform' : method === 'DEPOSIT' ? 'Pakai uang muka' : `Pakai ${METHOD_LABEL[method]}`} · {rp(amountOk ? amount : 0)}
        </button>
      </div>
    </Modal>
  );
}
