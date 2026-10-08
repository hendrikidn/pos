import { useState } from 'react';
import { Modal } from './dialogs';
import { run, type Ctx } from './ui';

const REASONS = ['Tukar uang kecil', 'Setor ke brankas', 'Tambah modal laci', 'Lainnya'];

/** Membuka laci kas tanpa transaksi: wajib beralasan dan disetujui orang lain. Dicatat sebagai event dan ditinjau owner (R17). */
export function DrawerDialog({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function open() {
    setBusy(true);
    const approvers = await ctx.approve(1, 'Membuka laci tanpa transaksi memerlukan persetujuan.');
    if (!approvers) return setBusy(false);
    const r = await run(ctx, () => ctx.rt.engine.openDrawer(reason, approvers[0]!));
    setBusy(false);
    if (r.ok) {
      ctx.toast('Laci dibuka dan dicatat', 'info');
      onClose();
    }
  }
  return (
    <Modal title="Buka laci tanpa transaksi" onClose={onClose}>
      <p className="muted">Setiap pembukaan dicatat dengan alasan dan nama penyetuju, lalu ditinjau owner.</p>
      <div className="reasons">
        {REASONS.map((r) => <button key={r} className={reason === r ? '' : 'secondary'} aria-pressed={reason === r} onClick={() => setReason(r)}>{r}</button>)}
      </div>
      <label className="field">Alasan<input value={reason} maxLength={60} onChange={(e) => setReason(e.target.value)} /></label>
      <div className="actions"><button className="secondary" onClick={onClose}>Batal</button><button disabled={busy || reason.trim().length < 3} onClick={() => void open()}>Minta persetujuan dan buka</button></div>
    </Modal>
  );
}
