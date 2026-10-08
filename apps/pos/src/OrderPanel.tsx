import { useState } from 'react';
import type { MenuItem, OrderRecord } from '@pos/pos-core';
import { lineKey, VOID_REASONS } from '@pos/pos-core';
import { Qr } from './Qr';
import { MergeDialog, Modal, ModifierDialog, MoveTableDialog, NoteDialog, PayDialog, PinPad, SplitDialog } from './dialogs';
import { approvalHint, isPaid, METHOD_LABEL, NEEDS_APPROVAL, orderLabel, rp, run, STATUS_LABEL, type Ctx } from './ui';

type Dialog = 'qr' | 'pay' | 'discount' | 'void' | 'decline' | 'refund' | 'table' | 'split' | 'merge' | null;

export function OrderPanel({ ctx, order }: { ctx: Ctx; order: OrderRecord }) {
  const { engine, config } = ctx.rt;
  const [dlg, setDlg] = useState<Dialog>(null);
  const [category, setCategory] = useState(config.menu[0]?.category ?? '');
  const [choosing, setChoosing] = useState<MenuItem | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const totals = engine.totals(order);
  const locked = order.state.status !== 'DRAFT' && order.state.status !== 'SENT';
  const paid = isPaid(order);
  const final = order.state.status === 'VOIDED' || order.state.status === 'MERGED' || paid;
  const open = order.state.status === 'DRAFT' || order.state.status === 'SENT';
  const splittable = open && order.type !== 'EMPLOYEE';
  const digitalOk = ctx.rt.receiptUrl('x') !== null;
  const itemCount = order.items.reduce((s, l) => s + l.qty, 0);
  const mergeable = order.type === 'EMPLOYEE' || !open ? [] : engine.listOrders().filter(
    (o) => o.id !== order.id && o.type === order.type && o.shiftId === order.shiftId && (o.state.status === 'DRAFT' || o.state.status === 'SENT') && o.items.length > 0,
  );
  const categories = [...new Set(config.menu.map((m) => m.category))];
  const threshold = config.policy?.secondApprovalAbove ?? 50_000;

  async function startPay() {
    if (!order.state.billPrinted) {
      let r = await engine.printBill(order.id);
      if (!r.ok && r.code === 'PRINT_FAILED') {
        if (!window.confirm('Printer tidak bisa mencetak. Tampilkan tagihan di layar customer dan lanjutkan?')) return ctx.bump();
        r = await engine.printBill(order.id, { onScreen: true });
      }
      if (!r.ok) return ctx.toast(r.message, 'error');
      ctx.bump();
    }
    setDlg('pay');
  }

  async function withApproval<T>(
    attempt: (approvers: { userId: string; pin: string }[]) => Promise<ReturnType<typeof engine.voidOrder> extends Promise<infer R> ? R : never>,
    need: number,
  ) {
    let r = await attempt([]);
    if (!r.ok && NEEDS_APPROVAL.has(r.code)) {
      const approvers = await ctx.approve(need, approvalHint(r.code));
      if (!approvers) return;
      r = await attempt(approvers);
    }
    if (!r.ok) ctx.toast(r.message, 'error');
    ctx.bump();
    return r;
  }

  const qtyOf = (id: string) => order.items.filter((l) => l.itemId === id).reduce((s, l) => s + l.qty, 0);

  return (
    <section className={`order-panel ${locked ? 'locked' : ''}`} aria-label={`Order ${order.number}`}>
      {!locked && (
        <div className="menu-pane">
          <div className="chips">
            {categories.map((c) => (
              <button key={c} className={`chip ${c === category ? 'on' : ''}`} onClick={() => setCategory(c)}>{c}</button>
            ))}
          </div>
          <div className="menu">
            {config.menu.filter((m) => m.category === category).map((m) => {
              const n = qtyOf(m.id);
              return (
                <button
                  key={m.id}
                  className={`menu-item ${n > 0 ? 'has' : ''}`}
                  onClick={() => (m.modifierGroups?.length ? setChoosing(m) : void run(ctx, () => engine.addItem(order.id, m.id, 1)))}
                >
                  <span>{m.name}</span>
                  <b>{m.modifierGroups?.length ? `mulai ${rp(m.price)}` : rp(m.price)}</b>
                  {n > 0 && <i className="qty-badge" aria-label={`${n} di keranjang`}>{n}</i>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <aside className="cart-pane">
        <header className="order-head">
          <div>
            <h2>#{order.number} · {orderLabel(order, engine.staff())}</h2>
            <span className={`pill s-${order.state.status}`}>{STATUS_LABEL[order.state.status]}</span>
            {engine.holdRequiredMinutes(order) !== null && !final && <span className="pill s-HOLD" title="Pembayaran tunai memerlukan alasan">Ditahan {engine.holdRequiredMinutes(order)} mnt</span>}
            {order.kitchen && <span className="pill">Dapur: {order.kitchen === 'COOKING' ? 'dimasak' : order.kitchen === 'READY' ? 'siap' : 'disajikan'}</span>}
          </div>
          <button className="ghost" onClick={() => ctx.selectOrder(null)}>Tutup</button>
        </header>

        <ul className="cart">
          {order.items.length === 0 && <li className="muted">Belum ada item. Ketuk menu untuk menambahkan.</li>}
          {order.items.map((l) => {
            const key = lineKey(l);
            return (
              <li key={key}>
                <span className="name">
                  {l.name}{l.sentQty > 0 && <small> · terkirim {l.sentQty}</small>}
                  {l.options && l.options.length > 0 && <small className="line-opts">{l.options.map((o) => o.name).join(' · ')}</small>}
                  {l.note && <small className="line-note">“{l.note}”</small>}
                  {!locked && l.sentQty === 0 && (
                    <button className="link-btn" onClick={() => setNoteFor(key)}>{l.note ? 'Ubah catatan' : '+ Catatan'}</button>
                  )}
                </span>
                {!locked ? (
                  <span className="qty">
                    <button aria-label="Kurangi" onClick={() => void run(ctx, () => engine.setQty(order.id, key, l.qty - 1))}>−</button>
                    <b>{l.qty}</b>
                    <button aria-label="Tambah" onClick={() => void run(ctx, () => engine.setQty(order.id, key, l.qty + 1))}>+</button>
                  </span>
                ) : (
                  <b>{l.qty}×</b>
                )}
                <span className="amt">{rp(l.qty * l.unitPrice)}</span>
              </li>
            );
          })}
        </ul>

        <dl className="totals">
          <div><dt>Subtotal</dt><dd>{rp(totals.subtotal)}</dd></div>
          {totals.discount > 0 && <div><dt>Diskon</dt><dd>−{rp(totals.discount)}</dd></div>}
          {totals.service > 0 && <div><dt>Service {config.serviceChargePercent}%</dt><dd>{rp(totals.service)}</dd></div>}
          {totals.tax > 0 && <div><dt>PBJT {config.taxPercent}%</dt><dd>{rp(totals.tax)}</dd></div>}
          {totals.rounding !== 0 && <div><dt>Pembulatan</dt><dd>{totals.rounding < 0 ? '−' : ''}{rp(Math.abs(totals.rounding))}</dd></div>}
          <div className="grand"><dt>Total</dt><dd>{rp(totals.total)}</dd></div>
          {order.payments.length > 0 && (
            <div><dt>Dibayar ({order.payments.map((p) => METHOD_LABEL[p.method]).join(', ')})</dt><dd>{rp(totals.total - engine.outstanding(order))}</dd></div>
          )}
        </dl>

        {!final && (
          <div className="order-actions">
            <button className="pay" disabled={order.items.length === 0} onClick={() => void startPay()}>Bayar {rp(engine.outstanding(order) || totals.total)}</button>
            <div className="sub">
              <button className="secondary" disabled={order.items.every((l) => l.qty <= l.sentQty)} onClick={() => void run(ctx, () => engine.sendToKitchen(order.id))}>Ke dapur</button>
              <button className="secondary" disabled={order.items.length === 0} onClick={() => setDlg('discount')}>Diskon</button>
              <button className="secondary danger" onClick={() => setDlg('void')}>Void</button>
            </div>
            {(order.type === 'DINE_IN' || splittable) && (
              <div className="sub">
                {order.type === 'DINE_IN' && <button className="secondary" onClick={() => setDlg('table')}>Pindah meja</button>}
                {splittable && <button className="secondary" disabled={itemCount < 2} onClick={() => setDlg('split')}>Pisah bill</button>}
                {splittable && <button className="secondary" disabled={mergeable.length === 0} onClick={() => setDlg('merge')}>Gabung</button>}
              </div>
            )}
          </div>
        )}

        {paid && (
          <div className="receipt-box">
            <h3>Struk</h3>
            {order.receipt === 'NONE' ? (
              <>
                {(ctx.rt.engine.paperClaimActive() || ctx.rt.printerState() === 'paperOut') && (
                  <p className="notice">
                    {digitalOk
                      ? 'Kertas habis. Struk digital (QR) dibuat otomatis dan tampil di layar customer; atau catat bahwa struk tidak diberikan.'
                      : 'Kertas habis dan struk digital belum tersedia di terminal ini. Catat bahwa struk tidak diberikan.'}
                  </p>
                )}
                <div className="actions wrap">
                  <button onClick={() => void run(ctx, () => engine.printReceipt(order.id))}>Cetak struk</button>
                  {digitalOk && <button className="secondary" onClick={() => void run(ctx, () => engine.digitalReceipt(order.id)).then((r) => r.ok && setDlg('qr'))}>Struk digital (QR)</button>}
                  <button className="secondary" onClick={() => setDlg('decline')}>Struk tidak diberikan…</button>
                  <button className="secondary danger" onClick={() => setDlg('refund')}>Refund</button>
                  <button className="secondary danger" onClick={() => setDlg('void')}>Void</button>
                </div>
              </>
            ) : (
              <>
                <p className="muted">
                  {order.receipt === 'PRINTED' ? 'Struk dicetak.' : order.receipt === 'DIGITAL' ? 'Struk digital dibuat (QR di layar customer).' : 'Struk tidak diberikan (tercatat).'}
                </p>
                <div className="actions wrap">
                  {order.receipt !== 'DECLINED' && digitalOk && (
                    <button className="secondary" onClick={() => void run(ctx, () => engine.digitalReceipt(order.id)).then((r) => r.ok && setDlg('qr'))}>
                      {order.receiptToken ? 'Tampilkan QR' : 'Struk digital (QR)'}
                    </button>
                  )}
                  {order.receipt === 'DIGITAL' && <button className="secondary" onClick={() => void run(ctx, () => engine.printReceipt(order.id))}>Cetak struk</button>}
                  <button className="secondary danger" onClick={() => setDlg('refund')}>Refund</button>
                  <button className="secondary danger" onClick={() => setDlg('void')}>Void</button>
                </div>
              </>
            )}
          </div>
        )}
      </aside>

      {choosing && (
        <ModifierDialog
          item={choosing}
          onClose={() => setChoosing(null)}
          onAdd={async (v) => {
            const r = await run(ctx, () => engine.addItem(order.id, choosing.id, v.qty, { options: v.options, note: v.note }));
            if (r.ok) setChoosing(null);
          }}
        />
      )}
      {noteFor && (
        <NoteDialog
          title="Catatan"
          initial={order.items.find((l) => lineKey(l) === noteFor)?.note ?? ''}
          onClose={() => setNoteFor(null)}
          onSave={async (note) => {
            const r = await run(ctx, () => engine.setNote(order.id, noteFor, note));
            if (r.ok) setNoteFor(null);
          }}
        />
      )}
      {dlg === 'qr' && order.receiptToken && ctx.rt.receiptUrl(order.receiptToken) && (
        <Modal title="Struk digital" onClose={() => setDlg(null)}>
          <div className="qr-box">
            <Qr value={ctx.rt.receiptUrl(order.receiptToken)!} size={260} label="Kode QR struk digital" />
            <p className="muted">Customer memindai dengan kamera ponsel. Tidak perlu nomor HP. QR yang sama tampil di layar customer.</p>
            <p className="small mono">{ctx.rt.receiptUrl(order.receiptToken)}</p>
          </div>
          <div className="actions"><button onClick={() => setDlg(null)}>Selesai</button></div>
        </Modal>
      )}
      {dlg === 'table' && (
        <MoveTableDialog
          order={order}
          onClose={() => setDlg(null)}
          onSave={async (table) => {
            const r = await run(ctx, () => engine.moveTable(order.id, table));
            if (r.ok) setDlg(null);
          }}
        />
      )}
      {dlg === 'split' && (
        <SplitDialog
          order={order}
          onClose={() => setDlg(null)}
          onSplit={async (picks) => {
            const r = await run(ctx, () => engine.splitOrder(order.id, picks));
            if (r.ok) {
              setDlg(null);
              ctx.toast(`Bill baru #${r.value.number} dibuat`, 'info');
              ctx.selectOrder(r.value.id);
            }
          }}
        />
      )}
      {dlg === 'merge' && (
        <MergeDialog
          order={order}
          candidates={mergeable}
          totalOf={(o) => engine.totals(o).total}
          onClose={() => setDlg(null)}
          onMerge={async (fromId) => {
            const r = await run(ctx, () => engine.mergeOrders(order.id, fromId));
            if (r.ok) setDlg(null);
          }}
        />
      )}
      {dlg === 'pay' && <PayDialog ctx={ctx} order={order} onClose={() => setDlg(null)} />}
      {dlg === 'discount' && <DiscountDialog ctx={ctx} order={order} onClose={() => setDlg(null)} withApproval={withApproval} />}
      {dlg === 'void' && (
        <Modal title="Void order" onClose={() => setDlg(null)}>
          <p className="muted">
            Pilih alasan. Order yang sudah dikirim ke dapur atau ditagih memerlukan persetujuan supervisor; setelah dibayar memerlukan owner.
          </p>
          <div className="reasons">
            {VOID_REASONS.map((r) => (
              <button
                key={r.code}
                className="secondary"
                onClick={async () => {
                  const need = order.state.status !== 'DRAFT' && totals.total > threshold ? 2 : 1;
                  const res = await withApproval((a) => engine.voidOrder(order.id, r.code, a), need);
                  if (res?.ok) {
                    setDlg(null);
                    ctx.selectOrder(null);
                  }
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
        </Modal>
      )}
      {dlg === 'decline' && (
        <Modal title="Struk tidak diberikan" onClose={() => setDlg(null)}>
          <p className="muted">Alasan dicatat dan dipantau. Struk digital tersedia jika customer mau.</p>
          <div className="reasons">
            {([['CUSTOMER_DECLINED', 'Customer tidak mau'], ['NO_PAPER', 'Kertas habis'], ['NO_PHONE', 'Tidak mau memberi nomor HP']] as const).map(([code, label]) => (
              <button key={code} className="secondary" onClick={async () => { const r = await run(ctx, () => engine.declineReceipt(order.id, code)); if (r.ok) setDlg(null); }}>{label}</button>
            ))}
          </div>
        </Modal>
      )}
      {dlg === 'refund' && <RefundDialog ctx={ctx} order={order} onClose={() => setDlg(null)} withApproval={withApproval} />}
    </section>
  );
}

type WithApproval = (
  attempt: (a: { userId: string; pin: string }[]) => Promise<any>,
  need: number,
) => Promise<{ ok: boolean } | undefined>;

function DiscountDialog({ ctx, order, onClose, withApproval }: { ctx: Ctx; order: OrderRecord; onClose: () => void; withApproval: WithApproval }) {
  const [kind, setKind] = useState<'MANUAL' | 'MEMBER' | 'COUPON'>('MANUAL');
  const [percent, setPercent] = useState('10');
  const [verified, setVerified] = useState(false);
  return (
    <Modal title="Diskon" onClose={onClose}>
      <div className="seg">
        {([['MANUAL', 'Manual'], ['MEMBER', 'Member'], ['COUPON', 'Kupon']] as const).map(([k, l]) => (
          <button key={k} className={kind === k ? 'on' : ''} onClick={() => { setKind(k); setVerified(k !== 'MANUAL'); }}>{l}</button>
        ))}
      </div>
      <label className="field">Persen diskon
        <input inputMode="numeric" value={percent} onChange={(e) => setPercent(e.target.value.replace(/\D/g, ''))} />
      </label>
      {kind !== 'MANUAL' && (
        <label className="check"><input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} /> Member/kupon sudah diverifikasi (scan atau OTP)</label>
      )}
      <p className="muted">Diskon manual di atas 15% tanpa verifikasi, atau diskon setelah tagihan dicetak, memerlukan persetujuan supervisor.</p>
      <div className="actions">
        <button className="secondary" onClick={onClose}>Batal</button>
        <button
          disabled={!percent || Number(percent) < 1 || Number(percent) > 100}
          onClick={async () => {
            const r = await withApproval((a) => ctx.rt.engine.applyDiscount(order.id, { kind, percent: Number(percent), verified, approver: a[0] }), 1);
            if (r?.ok) onClose();
          }}
        >
          Terapkan
        </button>
      </div>
    </Modal>
  );
}

function RefundDialog({ ctx, order, onClose, withApproval }: { ctx: Ctx; order: OrderRecord; onClose: () => void; withApproval: WithApproval }) {
  const paidAmount = order.payments.reduce((s, p) => s + p.amount, 0);
  const [amount, setAmount] = useState(String(paidAmount));
  return (
    <Modal title="Refund" onClose={onClose}>
      <label className="field">Nominal (maks. {rp(paidAmount)})
        <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} />
      </label>
      <p className="muted">Refund selalu memerlukan persetujuan supervisor; di atas Rp 50.000 memerlukan owner.</p>
      <div className="actions">
        <button className="secondary" onClick={onClose}>Batal</button>
        <button
          disabled={!amount || Number(amount) < 1 || Number(amount) > paidAmount}
          onClick={async () => {
            const approvers = await ctx.approve(1, 'Refund memerlukan persetujuan.');
            if (!approvers) return;
            const r = await run(ctx, () => ctx.rt.engine.refund(order.id, Number(amount), order.payments[0]?.method ?? 'CASH', approvers[0]!));
            if (r.ok) onClose();
          }}
        >
          Proses refund
        </button>
      </div>
    </Modal>
  );
}

export { PinPad };
