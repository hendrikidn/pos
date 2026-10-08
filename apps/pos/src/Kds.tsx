import { useEffect, useMemo, useRef, useState } from 'react';
import type { KitchenStatus } from '@pos/events';
import type { KdsLine, KdsTicket } from '@pos/order';
import type { KdsRuntime } from './kds-runtime';
import { Logo } from './Logo';
import { TYPE_LABEL } from './ui';

/** Tiket yang menunggu lebih lama dari ini berubah warna: perhatian, lalu terlambat. */
export const KDS_WARN_MIN = 8;
export const KDS_LATE_MIN = 12;

type Column = 'NEW' | 'COOKING' | 'READY';
const COLUMNS: { key: Column; title: string; next: KitchenStatus; action: string }[] = [
  { key: 'NEW', title: 'Baru', next: 'COOKING', action: 'Mulai masak' },
  { key: 'COOKING', title: 'Dimasak', next: 'READY', action: 'Siap' },
  { key: 'READY', title: 'Siap saji', next: 'SERVED', action: 'Disajikan' },
];

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Bunyi pendek untuk tiket baru. AudioContext baru boleh berbunyi setelah ada sentuhan pertama dari pengguna. */
function useBeep() {
  const ctx = useRef<AudioContext | null>(null);
  useEffect(() => {
    const unlock = () => {
      try {
        ctx.current ??= new AudioContext();
        void ctx.current.resume();
      } catch {
        /* tanpa audio: layar tetap berfungsi */
      }
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);
  return () => {
    const a = ctx.current;
    if (!a || a.state !== 'running') return;
    const o = a.createOscillator();
    const g = a.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.2, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.4);
    o.connect(g).connect(a.destination);
    o.start();
    o.stop(a.currentTime + 0.4);
  };
}

function Lines({ lines }: { lines: KdsLine[] }) {
  return (
    <ul className="kds-lines">
      {lines.map((l, i) => (
        <li key={i} className={l.fresh ? 'fresh' : ''}>
          <b className="kds-qty">{l.qty}×</b>
          <span>
            {l.name}
            {l.fresh && <em className="kds-tag">BARU</em>}
            {l.options.length > 0 && <small>{l.options.join(' · ')}</small>}
            {l.note && <small className="kds-note">“{l.note}”</small>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Card({ t, now, offsetMs, next, action, onAdvance }: { t: KdsTicket; now: number; offsetMs: number; next: KitchenStatus; action: string; onAdvance: (s: KitchenStatus) => void }) {
  const waited = now - offsetMs - t.firstSentAt;
  const min = waited / 60_000;
  const level = min >= KDS_LATE_MIN ? 'late' : min >= KDS_WARN_MIN ? 'warn' : 'ok';
  return (
    <article className={`kds-card ${level} ${t.hasNew ? 'has-new' : ''}`} aria-label={`Tiket ${t.ref}`}>
      <header>
        <h3>#{t.ref}{t.table ? ` · Meja ${t.table}` : t.type ? ` · ${TYPE_LABEL[t.type]}` : ''}</h3>
        <time aria-label="Lama menunggu">{clock(waited)}</time>
      </header>
      {t.hasNew && <p className="kds-banner">ITEM BARU DITAMBAHKAN</p>}
      {t.noDetail ? <p className="muted">Rincian item tidak tersedia (terminal versi lama). Lihat tiket cetak.</p> : <Lines lines={t.lines} />}
      <button className={`kds-act s-${next}`} onClick={() => onAdvance(next)}>{action}</button>
    </article>
  );
}

/** Layar dapur: tiket dari semua terminal outlet, satu tombol besar per tiket untuk memajukan statusnya. */
export function Kds({ runtime }: { runtime: KdsRuntime }) {
  const [, setTick] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [col, setCol] = useState<Column>('NEW');
  const beep = useBeep();
  const seen = useRef<Map<string, boolean> | null>(null);

  useEffect(() => runtime.subscribe(() => setTick((n) => n + 1)), [runtime]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    // Layar tidak boleh mati sendiri di dapur.
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    void nav.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => undefined);
    return () => void lock?.release();
  }, []);

  const { tickets, voided } = runtime.view();
  const st = runtime.state();

  // Bunyi saat ada tiket baru atau item susulan (bukan pada pemuatan pertama).
  useEffect(() => {
    if (!st.board) return;
    const cur = new Map(tickets.map((t) => [t.orderId, t.hasNew]));
    const prev = seen.current;
    seen.current = cur;
    if (!prev) return;
    for (const [id, hasNew] of cur) {
      if (!prev.has(id) || (hasNew && !prev.get(id))) {
        beep();
        break;
      }
    }
  });

  const byCol = useMemo(() => {
    const m: Record<Column, KdsTicket[]> = { NEW: [], COOKING: [], READY: [] };
    for (const t of tickets) if (t.status !== 'SERVED') m[t.status].push(t);
    return m;
  }, [tickets]);

  const stale = st.lastOkAt === null || now - st.lastOkAt > 10_000;

  return (
    <div className="kds">
      <header className="kds-top">
        <div className="brand"><Logo size={32} />{runtime.outletName} · Dapur</div>
        <div className="kds-counts" aria-label="Jumlah tiket">
          {COLUMNS.map((c) => <span key={c.key}>{c.title} <b>{byCol[c.key].length}</b></span>)}
        </div>
        <div className={`kds-link ${stale ? 'bad' : 'ok'}`} role="status">
          {stale ? (st.error ?? 'Menghubungkan…') : 'Terhubung'}
          {st.pending > 0 && ` · ${st.pending} perubahan menunggu dikirim`}
        </div>
      </header>

      {voided.length > 0 && (
        <section className="kds-voids" aria-label="Order dibatalkan">
          {voided.map((v) => (
            <div key={v.orderId} className="kds-void" role="alert">
              <div>
                <b>DIBATALKAN #{v.ref}{v.table ? ` · Meja ${v.table}` : ''}</b>: hentikan dan buang. {v.lines.map((l) => `${l.qty}× ${l.name}`).join(', ')}
              </div>
              <button className="secondary" onClick={() => runtime.dismissVoided(v.orderId)}>Mengerti</button>
            </div>
          ))}
        </section>
      )}

      <nav className="kds-tabs" aria-label="Kolom">
        {COLUMNS.map((c) => (
          <button key={c.key} className={col === c.key ? 'on' : ''} onClick={() => setCol(c.key)}>{c.title} <b>{byCol[c.key].length}</b></button>
        ))}
      </nav>

      <main className="kds-board">
        {COLUMNS.map((c) => (
          <section key={c.key} className={`kds-col ${col === c.key ? 'show' : ''}`} aria-label={c.title}>
            <h2>{c.title}</h2>
            {byCol[c.key].length === 0 && <p className="kds-empty">{c.key === 'NEW' ? 'Belum ada tiket baru.' : 'Kosong.'}</p>}
            {byCol[c.key].map((t) => (
              <Card key={t.orderId} t={t} now={now} offsetMs={st.offsetMs} next={c.next} action={c.action} onAdvance={(s) => void runtime.setStatus(t.orderId, s)} />
            ))}
          </section>
        ))}
      </main>
    </div>
  );
}
