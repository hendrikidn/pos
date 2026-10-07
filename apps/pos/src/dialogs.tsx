import { useState, type ReactNode } from 'react';
import type { OrderRecord, StaffPublic } from '@pos/pos-core';
import { METHOD_LABEL, rp, type Ctx } from './ui';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button className="ghost" onClick={onClose} aria-label="Tutup">✕</button>
        </header>
        {children}
      </div>
    </div>
  );
}

/** Papan angka untuk PIN dan nominal. */
export function PinPad({ value, onChange, max = 6 }: { value: string; onChange: (v: string) => void; max?: number }) {
  return (
    <div className="pinpad">
      <div className="pin-dots" aria-label="PIN">{'●'.repeat(value.length) || '—'}</div>
      {['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'C'].map((k) => (
        <button
          key={k}
          type="button"
          className="key"
          onClick={() => onChange(k === '⌫' ? value.slice(0, -1) : k === 'C' ? '' : value.length < max ? value + k : value)}
        >
          {k}
        </button>
      ))}
    </div>
  );
}

/** Persetujuan dari satu atau dua orang lain (supervisor ke atas). */
export function ApprovalDialog({
  need, message, staff, currentUser, onDone,
}: {
  need: number;
  message: string;
  staff: StaffPublic[];
  currentUser: string;
  onDone: (v: { userId: string; pin: string }[] | null) => void;
}) {
  const eligible = staff.filter((s) => s.id !== currentUser && s.role !== 'CASHIER');
  const [rows, setRows] = useState(() => Array.from({ length: need }, (_, i) => ({ userId: eligible[i]?.id ?? '', pin: '' })));
  const [focus, setFocus] = useState(0);
  const set = (i: number, patch: Partial<{ userId: string; pin: string }>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const ready = rows.every((r) => r.userId && r.pin.length >= 4) && new Set(rows.map((r) => r.userId)).size === rows.length;

  return (
    <Modal title="Perlu persetujuan" onClose={() => onDone(null)}>
      <p className="muted">{message}</p>
      {rows.map((row, i) => (
        <div key={i} className={`approver ${focus === i ? 'focus' : ''}`} onClick={() => setFocus(i)}>
          <label>
            Approver {need > 1 ? i + 1 : ''}
            <select value={row.userId} onChange={(e) => set(i, { userId: e.target.value })}>
              <option value="">Pilih…</option>
              {eligible.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <div className="pin-dots small">{'●'.repeat(row.pin.length) || 'PIN'}</div>
        </div>
      ))}
      <PinPad value={rows[focus]?.pin ?? ''} onChange={(v) => set(focus, { pin: v })} />
      <div className="actions">
        <button className="secondary" onClick={() => onDone(null)}>Batal</button>
        <button disabled={!ready} onClick={() => onDone(rows)}>Setujui</button>
      </div>
    </Modal>
  );
}

export function PayDialog({ ctx, order, onClose }: { ctx: Ctx; order: OrderRecord; onClose: () => void }) {
  const { engine, config } = ctx.rt;
  const due = engine.outstanding(order);
  const [method, setMethod] = useState<'CASH' | 'QRIS' | 'EDC_DEBIT' | 'EDC_CREDIT'>('CASH');
  const [tendered, setTendered] = useState('');
  const [tid, setTid] = useState(config.edcs[0]?.tid ?? '');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const cash = Number(tendered || 0);
  const quick = [...new Set([due, Math.ceil(due / 10_000) * 10_000, Math.ceil(due / 50_000) * 50_000, 100_000])].filter((n) => n >= due);

  async function submit() {
    setBusy(true);
    const r = await engine.pay(order.id, {
      method,
      ...(method === 'CASH' ? { tendered: cash || due } : { tid, approvalCode: code.trim() || undefined }),
    });
    setBusy(false);
    ctx.bump();
    if (!r.ok) return ctx.toast(r.message, 'error');
    ctx.toast(method === 'CASH' && r.value.change > 0 ? `Kembalian ${rp(r.value.change)}` : 'Pembayaran tercatat', 'info');
    onClose();
  }

  return (
    <Modal title={`Bayar ${rp(due)}`} onClose={onClose}>
      <div className="seg seg-2">
        {(['CASH', 'QRIS', 'EDC_DEBIT', 'EDC_CREDIT'] as const).map((m) => (
          <button key={m} className={method === m ? 'on' : ''} onClick={() => setMethod(m)}>{METHOD_LABEL[m]}</button>
        ))}
      </div>
      {method === 'CASH' ? (
        <>
          <label className="field">Uang diterima
            <input inputMode="numeric" value={tendered} onChange={(e) => setTendered(e.target.value.replace(/\D/g, ''))} placeholder={String(due)} />
          </label>
          <div className="quick">
            {quick.map((n) => (
              <button key={n} className="secondary" onClick={() => setTendered(String(n))}>{rp(n)}</button>
            ))}
          </div>
          {cash > due && <p className="change">Kembalian {rp(cash - due)}</p>}
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
      <div className="actions">
        <button className="secondary" onClick={onClose}>Batal</button>
        <button disabled={busy || (method === 'CASH' && cash > 0 && cash < due)} onClick={submit}>Konfirmasi</button>
      </div>
    </Modal>
  );
}
