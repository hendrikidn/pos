import { useState, type ReactNode } from 'react';
import { lineKey, type MenuItem, type OrderRecord, type StaffPublic } from '@pos/pos-core';
import { resolveSelection } from '@pos/order';
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
  need, message, staff, currentUser, exclude = [], onDone,
}: {
  need: number;
  message: string;
  staff: StaffPublic[];
  currentUser: string;
  exclude?: string[];
  onDone: (v: { userId: string; pin: string }[] | null) => void;
}) {
  const eligible = staff.filter((s) => s.id !== currentUser && s.role !== 'CASHIER' && !exclude.includes(s.id));
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
  const [part, setPart] = useState('');
  const amount = part === '' ? due : Number(part);
  const cash = Number(tendered || 0);
  const quick = [...new Set([amount, Math.ceil(amount / 10_000) * 10_000, Math.ceil(amount / 50_000) * 50_000, 100_000])].filter((n) => n >= amount);
  const partial = amount > 0 && amount < due;
  const amountOk = Number.isInteger(amount) && amount > 0 && amount <= due;

  async function submit() {
    setBusy(true);
    const r = await engine.pay(order.id, {
      method,
      amount,
      ...(method === 'CASH' ? { tendered: cash || amount } : { tid, approvalCode: code.trim() || undefined }),
    });
    setBusy(false);
    ctx.bump();
    if (!r.ok) return ctx.toast(r.message, 'error');
    const left = engine.outstanding(r.value.order);
    ctx.toast(
      method === 'CASH' && r.value.change > 0 ? `Kembalian ${rp(r.value.change)}` : left > 0 ? `Tercatat. Sisa tagihan ${rp(left)}` : 'Pembayaran tercatat',
      'info',
    );
    onClose();
  }

  return (
    <Modal title={`Bayar ${rp(amountOk ? amount : due)}`} onClose={onClose}>
      <label className="field">Nominal yang dibayar sekarang (sisa tagihan {rp(due)})
        <input inputMode="numeric" value={part} onChange={(e) => setPart(e.target.value.replace(/\D/g, ''))} placeholder={String(due)} />
      </label>
      <div className="quick" aria-label="Bagi rata">
        <button type="button" className="secondary" onClick={() => setPart('')}>Penuh</button>
        {[2, 3, 4].map((n) => (
          <button key={n} type="button" className="secondary" onClick={() => setPart(String(Math.min(due, Math.ceil(due / n))))}>Bagi {n}</button>
        ))}
      </div>
      {partial && <p className="notice">Pembayaran sebagian. Sisa {rp(due - amount)} dibayar kemudian (metode boleh berbeda).</p>}
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
          {cash > amount && <p className="change">Kembalian {rp(cash - amount)}</p>}
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
        <button disabled={busy || !amountOk || (method === 'CASH' && cash > 0 && cash < amount)} onClick={submit}>Konfirmasi</button>
      </div>
    </Modal>
  );
}

const NOTE_MAX = 140;

/**
 * Memilih varian dan tambahan untuk satu menu. Grup wajib (min ≥ 1) ditandai; tombol Tambah baru aktif bila semua batas
 * terpenuhi, dan harga akhir per porsi ditampilkan langsung. Pilihan satu-satunya (max 1) bersifat radio, selebihnya centang.
 */
export function ModifierDialog({
  item, onClose, onAdd,
}: {
  item: MenuItem;
  onClose: () => void;
  onAdd: (v: { options: string[]; note: string; qty: number }) => void;
}) {
  const groups = item.modifierGroups ?? [];
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [qty, setQty] = useState(1);
  const sel = resolveSelection(groups, picked);
  const unit = item.price + (sel.ok ? sel.extra : picked.reduce((a, id) => a + (groups.flatMap((g) => g.options).find((o) => o.id === id)?.price ?? 0), 0));

  function toggle(groupId: string, optionId: string) {
    const g = groups.find((x) => x.id === groupId)!;
    setPicked((cur) => {
      if (cur.includes(optionId)) return cur.filter((x) => x !== optionId);
      if (g.max === 1) return [...cur.filter((x) => !g.options.some((o) => o.id === x)), optionId];
      const inGroup = cur.filter((x) => g.options.some((o) => o.id === x)).length;
      return inGroup >= g.max ? cur : [...cur, optionId];
    });
  }

  return (
    <Modal title={item.name} onClose={onClose}>
      {groups.map((g) => {
        const n = picked.filter((x) => g.options.some((o) => o.id === x)).length;
        return (
          <fieldset key={g.id} className="opt-group">
            <legend>
              {g.name}
              <small className={g.min > 0 && n < g.min ? 'need' : ''}>
                {g.min > 0 ? (g.max === 1 ? 'Wajib pilih satu' : `Pilih ${g.min}–${g.max}`) : g.max === 1 ? 'Opsional' : `Opsional, maks. ${g.max}`}
              </small>
            </legend>
            <div className="opts">
              {g.options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role={g.max === 1 ? 'radio' : 'checkbox'}
                  aria-checked={picked.includes(o.id)}
                  className={`opt ${picked.includes(o.id) ? 'on' : ''}`}
                  onClick={() => toggle(g.id, o.id)}
                >
                  <span>{o.name}</span>
                  {o.price > 0 && <b>+{rp(o.price)}</b>}
                </button>
              ))}
            </div>
          </fieldset>
        );
      })}
      <label className="field">Catatan untuk dapur (opsional)
        <input value={note} maxLength={NOTE_MAX} placeholder="mis. tanpa es, gula sedikit" onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="opt-foot">
        <span className="qty">
          <button type="button" aria-label="Kurangi" disabled={qty <= 1} onClick={() => setQty(qty - 1)}>−</button>
          <b>{qty}</b>
          <button type="button" aria-label="Tambah" disabled={qty >= 99} onClick={() => setQty(qty + 1)}>+</button>
        </span>
        <button type="button" className="pay" disabled={!sel.ok} onClick={() => sel.ok && onAdd({ options: picked, note, qty })}>
          {sel.ok ? `Tambah · ${rp(unit * qty)}` : sel.message}
        </button>
      </div>
    </Modal>
  );
}

/** Catatan untuk dapur pada satu baris yang belum dikirim. */
export function NoteDialog({ title, initial, onClose, onSave }: { title: string; initial: string; onClose: () => void; onSave: (note: string) => void }) {
  const [note, setNote] = useState(initial);
  return (
    <Modal title={title} onClose={onClose}>
      <label className="field">Catatan untuk dapur
        <input autoFocus value={note} maxLength={NOTE_MAX} placeholder="mis. tanpa es, gula sedikit" onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="actions">
        <button className="secondary" onClick={onClose}>Batal</button>
        <button onClick={() => onSave(note)}>Simpan</button>
      </div>
    </Modal>
  );
}

/** Pindah meja untuk order dine-in. */
export function MoveTableDialog({ order, onClose, onSave }: { order: OrderRecord; onClose: () => void; onSave: (table: string) => void }) {
  const [table, setTable] = useState('');
  return (
    <Modal title={`Pindah meja${order.tableNo ? ` (sekarang ${order.tableNo})` : ''}`} onClose={onClose}>
      <PinPad value={table} onChange={setTable} max={3} />
      <div className="actions">
        <button className="secondary" onClick={onClose}>Batal</button>
        <button disabled={!table} onClick={() => onSave(table)}>Pindahkan</button>
      </div>
    </Modal>
  );
}

/** Memilih item (dan jumlahnya) yang dibayar terpisah. Minimal satu item harus tetap di bill awal. */
export function SplitDialog({
  order, onClose, onSplit,
}: {
  order: OrderRecord;
  onClose: () => void;
  onSplit: (picks: { lineId: string; qty: number }[]) => void;
}) {
  const [qty, setQty] = useState<Record<string, number>>({});
  const total = order.items.reduce((s, l) => s + l.qty, 0);
  const picked = order.items.reduce((s, l) => s + (qty[lineKey(l)] ?? 0), 0);
  const value = order.items.reduce((s, l) => s + (qty[lineKey(l)] ?? 0) * l.unitPrice, 0);
  const set = (k: string, max: number, n: number) => setQty((q) => ({ ...q, [k]: Math.max(0, Math.min(max, n)) }));
  return (
    <Modal title="Pisah bill" onClose={onClose}>
      <p className="muted">Pilih item yang dibayar terpisah. Item itu pindah ke bill baru; sisanya tetap di bill ini.</p>
      <ul className="split-list">
        {order.items.map((l) => {
          const k = lineKey(l);
          const n = qty[k] ?? 0;
          return (
            <li key={k}>
              <span className="name">
                {l.name}
                {l.options && l.options.length > 0 && <small className="line-opts">{l.options.map((o) => o.name).join(' · ')}</small>}
                <small className="line-opts">{l.qty}× · {rp(l.unitPrice)}</small>
              </span>
              <span className="qty">
                <button type="button" aria-label="Kurangi" disabled={n === 0} onClick={() => set(k, l.qty, n - 1)}>−</button>
                <b>{n}</b>
                <button type="button" aria-label="Tambah" disabled={n >= l.qty} onClick={() => set(k, l.qty, n + 1)}>+</button>
              </span>
            </li>
          );
        })}
      </ul>
      {picked >= total && picked > 0 && <p className="notice">Sisakan minimal satu item di bill awal. Untuk memindahkan semuanya, gunakan Gabung.</p>}
      <div className="actions">
        <button className="secondary" onClick={onClose}>Batal</button>
        <button
          disabled={picked === 0 || picked >= total}
          onClick={() => onSplit(order.items.filter((l) => (qty[lineKey(l)] ?? 0) > 0).map((l) => ({ lineId: lineKey(l), qty: qty[lineKey(l)]! })))}
        >
          {picked > 0 ? `Pisahkan ${picked} item · ${rp(value)}` : 'Pisahkan'}
        </button>
      </div>
    </Modal>
  );
}

/** Memilih order lain yang digabung ke order ini. */
export function MergeDialog({
  order, candidates, onClose, onMerge, totalOf,
}: {
  order: OrderRecord;
  candidates: OrderRecord[];
  onClose: () => void;
  onMerge: (fromId: string) => void;
  totalOf: (o: OrderRecord) => number;
}) {
  const [from, setFrom] = useState<string | null>(null);
  const chosen = candidates.find((c) => c.id === from);
  return (
    <Modal title={`Gabungkan ke #${order.number}`} onClose={onClose}>
      {candidates.length === 0 ? (
        <p className="muted">Tidak ada order lain yang bisa digabung (harus sejenis, belum ditagih, dan berisi item).</p>
      ) : (
        <>
          <p className="muted">Pilih order yang itemnya dipindahkan ke #{order.number}. Order itu ditutup setelah digabung.</p>
          <div className="reasons">
            {candidates.map((c) => (
              <button key={c.id} className={c.id === from ? '' : 'secondary'} onClick={() => setFrom(c.id)}>
                #{c.number}{c.tableNo ? ` · Meja ${c.tableNo}` : ''} · {c.items.reduce((s, l) => s + l.qty, 0)} item · {rp(totalOf(c))}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="actions">
        <button className="secondary" onClick={onClose}>Batal</button>
        <button disabled={!chosen} onClick={() => chosen && onMerge(chosen.id)}>{chosen ? `Gabungkan #${chosen.number} ke #${order.number}` : 'Gabungkan'}</button>
      </div>
    </Modal>
  );
}
