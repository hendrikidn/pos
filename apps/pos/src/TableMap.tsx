import { useEffect, useState } from 'react';
import type { OrderRecord } from '@pos/pos-core';
import { summarizeTable, type TableOrderView, type TableState } from '@pos/order';
import { Modal, PinPad } from './dialogs';
import { rp, type Ctx } from './ui';

const STATE_LABEL: Record<TableState, string> = { FREE: 'Kosong', OCCUPIED: 'Terisi', SENT: 'Di dapur', BILLED: 'Menunggu bayar' };
/** Papan dari server lebih tua dari ini ditandai usang: terminal mungkin offline dan meja terlihat lebih kosong dari kenyataan. */
const BOARD_STALE_MS = 60_000;

const minutes = (since: number, now: number) => Math.max(0, Math.floor((now - since) / 60_000));
const duration = (m: number) => (m < 60 ? `${m} mnt` : `${Math.floor(m / 60)} j ${m % 60} mnt`);

/** Order dine-in terbuka milik terminal ini dalam bentuk yang sama dengan papan dari server. */
function localViews(ctx: Ctx): TableOrderView[] {
  const { engine } = ctx.rt;
  const deviceId = engine.config.deviceId;
  return engine.listOrders().flatMap((o: OrderRecord): TableOrderView[] => {
    const st = o.state.status;
    if (o.type !== 'DINE_IN' || !o.tableNo || (st !== 'DRAFT' && st !== 'SENT' && st !== 'BILLED')) return [];
    return [{
      orderId: o.id, deviceId, tableNo: o.tableNo, status: st, since: o.createdAt,
      total: st === 'BILLED' ? engine.totals(o).total : null,
      paid: o.payments.reduce((s, p) => s + p.amount, 0), kitchen: o.kitchen,
    }];
  });
}

/**
 * Denah meja berwarna: kosong, terisi, di dapur, menunggu bayar. Order terminal ini dibaca langsung dari engine (selalu terbaru),
 * order terminal lain dari papan server (kurang lebih 10 detik tertunda). Meja yang dipakai terminal lain tidak bisa dibuka
 * tanpa konfirmasi, agar dua kasir tidak menagih meja yang sama tanpa sadar.
 */
export function TableMap({ ctx, onPick, onClose }: { ctx: Ctx; onPick: (tableNo: string) => void; onClose: () => void }) {
  const { engine } = ctx.rt;
  const [now, setNow] = useState(Date.now());
  const [conflict, setConflict] = useState<{ no: string; others: TableOrderView[] } | null>(null);
  const [typing, setTyping] = useState<string | null>(null);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const defs = engine.config.tables ?? [];
  const remote = ctx.rt.tableBoard();
  // Mode demo tidak punya server, jadi tidak ada terminal lain yang perlu ditunggu.
  const stale = ctx.rt.configStatus().mode !== 'demo' && (remote === null || now - remote.at > BOARD_STALE_MS);
  const mine = localViews(ctx);
  const mineIds = new Set(mine.map((o) => o.orderId));
  const all = [...mine, ...(remote?.board.orders ?? []).filter((o) => o.deviceId !== engine.config.deviceId && !mineIds.has(o.orderId))];
  // Order di meja yang tidak ada di denah (diketik manual, atau denah diubah) tetap terlihat sebagai meja tambahan.
  const known = new Set(defs.map((d) => d.no));
  const extra = [...new Set(all.map((o) => o.tableNo))].filter((no) => !known.has(no)).sort();
  const areas = [...new Set(defs.map((d) => d.area))];
  const counts = (['FREE', 'OCCUPIED', 'SENT', 'BILLED'] as const).map((s) => [s, [...defs.map((d) => d.no), ...extra].filter((no) => summarizeTable(no, all).state === s).length] as const);

  function tap(no: string) {
    const s = summarizeTable(no, all);
    if (s.state === 'FREE') return onPick(no);
    const own = s.orders.filter((o) => mineIds.has(o.orderId));
    if (own.length > 0) {
      ctx.selectOrder(own[own.length - 1]!.orderId);
      return onClose();
    }
    setConflict({ no, others: s.orders });
  }

  const tile = (no: string, seats?: number) => {
    const s = summarizeTable(no, all);
    const theirs = s.orders.filter((o) => !mineIds.has(o.orderId));
    return (
      <button key={no} type="button" className={`tbl tbl-${s.state}`} onClick={() => tap(no)} aria-label={`Meja ${no}, ${STATE_LABEL[s.state]}`}>
        <b>{no}</b>
        <span>{STATE_LABEL[s.state]}</span>
        {s.since !== null && <small>{duration(minutes(s.since, now))}</small>}
        {s.due > 0 && <small>{rp(s.due)}</small>}
        {theirs.length > 0 && <small className="tbl-dev">{[...new Set(theirs.map((o) => o.deviceId))].join(', ')}</small>}
        {seats !== undefined && s.state === 'FREE' && <small>{seats} kursi</small>}
      </button>
    );
  };

  if (typing !== null) {
    return (
      <Modal title="Nomor meja" onClose={onClose}>
        <PinPad value={typing} onChange={setTyping} max={3} />
        <div className="actions">
          <button className="secondary" onClick={() => setTyping(null)}>Kembali ke denah</button>
          <button disabled={!typing} onClick={() => tap(typing)}>Buat order</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Pilih meja" onClose={onClose} wide>
      <ul className="tbl-legend" aria-label="Keterangan warna">
        {counts.map(([s, n]) => <li key={s} className={`tbl-${s}`}><i />{STATE_LABEL[s]} · {n}</li>)}
      </ul>
      {stale && <p className="notice">{remote === null ? 'Belum terhubung ke server: meja yang dipakai terminal lain belum terlihat.' : 'Data terminal lain tertunda lebih dari semenit; meja yang tampak kosong mungkin sudah terisi.'}</p>}
      {areas.map((area) => (
        <section key={area} className="tbl-area">
          <h3>{area}</h3>
          <div className="tbl-grid">{defs.filter((d) => d.area === area).map((d) => tile(d.no, d.seats))}</div>
        </section>
      ))}
      {extra.length > 0 && (
        <section className="tbl-area">
          <h3>Lainnya</h3>
          <div className="tbl-grid">{extra.map((no) => tile(no))}</div>
        </section>
      )}
      <div className="actions"><button className="secondary" onClick={() => setTyping('')}>Nomor lain…</button></div>

      {conflict && (
        <Modal title={`Meja ${conflict.no} sedang dipakai`} onClose={() => setConflict(null)}>
          <ul className="pay-list">
            {conflict.others.map((o) => (
              <li key={o.orderId}>
                <span>Terminal <b>{o.deviceId}</b> · {STATE_LABEL[o.status === 'DRAFT' ? 'OCCUPIED' : o.status === 'SENT' ? 'SENT' : 'BILLED']} · {duration(minutes(o.since, now))}</span>
                {o.total !== null && <b>{rp(Math.max(0, o.total - o.paid))}</b>}
              </li>
            ))}
          </ul>
          <p className="muted">Order di meja ini dipegang terminal lain dan hanya terminal itu yang bisa menagihnya. Buka order baru hanya bila tamu baru duduk bersama atau meja memang dibagi.</p>
          <div className="actions">
            <button className="secondary" onClick={() => setConflict(null)}>Batal</button>
            <button onClick={() => { const no = conflict.no; setConflict(null); onPick(no); }}>Tetap buka order baru</button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
