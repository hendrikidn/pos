import { useState } from 'react';
import { Modal } from './dialogs';
import type { QueueItem } from './runtime';
import type { Ctx } from './ui';

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
const mins = (ms: number) => Math.max(0, Math.round((Date.now() - ms) / 60_000));
const JUMP = [['TABLE_SIZE', 'Meja cocok (rombongan lebih kecil)'], ['PRIORITY', 'Prioritas (lansia, disabilitas, dll.)'], ['OTHER', 'Lainnya']] as const;

/**
 * Antrian meja untuk kasir. "Panggil" memanggil tiket; yang bukan giliran pertama berarti melewati antrian dan wajib beralasan (alasan
 * "meja cocok" hanya sah bila semua yang dilewati membawa rombongan lebih besar; selebihnya menjadi temuan untuk owner). "Duduk" memilih
 * meja lalu membuka order dine-in tertaut: tamu yang didudukkan tanpa order yang sah juga menjadi temuan.
 */
export function QueueDialog({ ctx, onSeated, onClose }: { ctx: Ctx; onSeated: (orderId: string) => void; onClose: () => void }) {
  const board = ctx.rt.queue();
  const tables = ctx.rt.engine.config.tables ?? [];
  const [busy, setBusy] = useState<number | 'add' | null>(null);
  const [jump, setJump] = useState<{ id: number; label: string; reason: string; note: string } | null>(null);
  const [seating, setSeating] = useState<QueueItem | null>(null);
  const [table, setTable] = useState('');
  const [adding, setAdding] = useState<{ partySize: string; name: string } | null>(null);
  const waiting = board?.tickets.filter((t) => t.status === 'WAITING') ?? [];
  const calling = board?.tickets.filter((t) => t.status === 'CALLED') ?? [];
  const oldest = waiting[0]?.id;

  async function act(action: 'add' | 'call' | 'recall' | 'seat' | 'no-show' | 'cancel', id: number | null, body: Record<string, unknown> = {}, ok?: string) {
    setBusy(id ?? 'add');
    const r = await ctx.rt.queueAct(action, id, body);
    setBusy(null);
    if (!r.ok) {
      ctx.toast(r.message, 'error');
      return null;
    }
    if (ok) ctx.toast(ok, 'info');
    return r.value;
  }

  async function seat() {
    if (!seating || !table) return;
    // Tamu dicatat duduk di server dulu, jadi pastikan order bisa dibuat (shift terbuka) sebelum itu; kalau tidak tiketnya duduk tanpa order (R49).
    if (!ctx.rt.engine.currentShift()) return ctx.toast('Buka shift terlebih dahulu sebelum mendudukkan tamu.', 'error');
    const v = await act('seat', seating.id, { tableNo: table });
    if (!v) return;
    const o = await ctx.rt.seatQueueOrder({ id: seating.id, label: seating.label }, table);
    ctx.bump();
    if (!o.ok) return ctx.toast(`Tamu sudah dicatat duduk di meja ${table}, tetapi order gagal dibuat: ${o.message}`, 'error');
    ctx.toast(`${seating.label} duduk di meja ${table}`, 'info');
    onSeated(o.value.id);
  }

  if (seating) {
    return (
      <Modal title={`Dudukkan ${seating.label}`} onClose={() => setSeating(null)}>
        <p className="muted">{seating.partySize} orang{seating.name ? ` · ${seating.name}` : ''}. Pilih meja; order dine-in dibuka otomatis.</p>
        <div className="tbl-grid">
          {tables.map((t) => <button key={t.no} type="button" className={`tbl tbl-FREE ${table === t.no ? 'on' : ''}`} aria-pressed={table === t.no} onClick={() => setTable(t.no)}><b>{t.no}</b><small>{t.seats} kursi</small></button>)}
        </div>
        {tables.length === 0 && <label className="field">Nomor meja<input value={table} maxLength={6} onChange={(e) => setTable(e.target.value)} /></label>}
        <div className="actions"><button className="secondary" onClick={() => setSeating(null)}>Kembali</button><button disabled={!table || busy !== null} onClick={() => void seat()}>Dudukkan di meja {table || '…'}</button></div>
      </Modal>
    );
  }

  if (jump) {
    return (
      <Modal title={`Panggil ${jump.label} melewati antrian`} onClose={() => setJump(null)}>
        <p className="notice">Ada tiket yang lebih lama menunggu. Pilih alasan; alasan selain &quot;meja cocok&quot; dicatat dan ditinjau owner.</p>
        <div className="reasons">
          {JUMP.map(([code, label]) => <button key={code} className={jump.reason === code ? '' : 'secondary'} aria-pressed={jump.reason === code} onClick={() => setJump({ ...jump, reason: code })}>{label}</button>)}
        </div>
        {jump.reason && jump.reason !== 'TABLE_SIZE' && <label className="field">Penjelasan<input value={jump.note} maxLength={80} onChange={(e) => setJump({ ...jump, note: e.target.value })} /></label>}
        <div className="actions">
          <button className="secondary" onClick={() => setJump(null)}>Batal</button>
          <button disabled={!jump.reason || busy !== null || (jump.reason !== 'TABLE_SIZE' && jump.note.trim().length < 3)} onClick={async () => { const v = await act('call', jump.id, { reason: jump.reason, note: jump.note }, `${jump.label} dipanggil`); if (v) setJump(null); }}>Panggil</button>
        </div>
      </Modal>
    );
  }

  if (adding) {
    return (
      <Modal title="Tambah tamu ke antrian" onClose={() => setAdding(null)}>
        <label className="field">Jumlah tamu<input inputMode="numeric" value={adding.partySize} onChange={(e) => setAdding({ ...adding, partySize: e.target.value.replace(/\D/g, '') })} /></label>
        <label className="field">Nama (opsional)<input value={adding.name} maxLength={40} onChange={(e) => setAdding({ ...adding, name: e.target.value })} /></label>
        <div className="actions">
          <button className="secondary" onClick={() => setAdding(null)}>Batal</button>
          <button disabled={!adding.partySize || busy !== null} onClick={async () => { const v = await act('add', null, { partySize: Number(adding.partySize), ...(adding.name.trim() ? { name: adding.name.trim() } : {}) }); if (v) { ctx.toast(`Nomor antrian ${String(v['label'])}`, 'info'); setAdding(null); } }}>Ambil nomor</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Antrian meja" onClose={onClose} wide>
      {board === null && <p className="notice">Belum terhubung ke server: antrian belum terlihat.</p>}
      {calling.length > 0 && <h3>Sedang dipanggil</h3>}
      <ul className="pay-list">
        {calling.map((t) => (
          <li key={t.id}>
            <span><b>{t.label}</b> · {t.partySize} orang{t.name ? ` · ${t.name}` : ''} · dipanggil {t.callCount}× (terakhir {t.calledAt ? `${mins(t.calledAt)} mnt lalu` : '–'})</span>
            <span className="actions">
              <button disabled={busy !== null} onClick={() => setSeating(t)}>Duduk</button>
              <button className="secondary" disabled={busy !== null} onClick={() => void act('recall', t.id, {}, `${t.label} dipanggil ulang`)}>Panggil ulang</button>
              <button className="secondary" disabled={busy !== null} onClick={() => void act('no-show', t.id, {}, `${t.label} ditandai tidak datang`)}>Tidak datang</button>
            </span>
          </li>
        ))}
      </ul>
      <h3>Menunggu · {waiting.length}</h3>
      {waiting.length === 0 && <p className="muted">Tidak ada yang menunggu.</p>}
      <ul className="pay-list">
        {waiting.map((t) => (
          <li key={t.id}>
            <span><b>{t.label}</b> · {t.partySize} orang{t.name ? ` · ${t.name}` : ''}{t.phone ? ` · ${t.phone}` : ''} · {hhmm(t.createdAt)} ({mins(t.createdAt)} mnt)</span>
            <span className="actions">
              <button disabled={busy !== null} onClick={() => (t.id === oldest ? void act('call', t.id, {}, `${t.label} dipanggil`) : setJump({ id: t.id, label: t.label, reason: '', note: '' }))}>Panggil</button>
              <button className="secondary" disabled={busy !== null} onClick={() => { const reason = window.prompt(`Alasan membatalkan ${t.label}:`); if (reason) void act('cancel', t.id, { reason }, `${t.label} dibatalkan`); }}>Batalkan</button>
            </span>
          </li>
        ))}
      </ul>
      <div className="actions"><button className="secondary" onClick={() => setAdding({ partySize: '2', name: '' })}>+ Tambah tamu</button><button className="secondary" onClick={onClose}>Tutup</button></div>
    </Modal>
  );
}
