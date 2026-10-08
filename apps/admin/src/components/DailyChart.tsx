'use client';

import { useState } from 'react';
import type { DailyPoint } from '@/lib/api';
import { dayLabel, dayShort, niceMax, num, rupiah, rupiahShort } from '@/lib/format';

type Metric = 'revenue' | 'orders';

const W = 640;
const H = 210;
const PAD = { l: 52, r: 8, t: 12, b: 26 };
const BAR_MAX = 24; // batas ketebalan batang

/**
 * Bar chart harian satu seri (satu hue): penerimaan atau jumlah pesanan 14 hari terakhir.
 * Batang tumbuh dari satu garis dasar, ujung atas membulat 4px, grid hairline, nilai hanya diberi label pada hari ini;
 * sisanya lewat tooltip (hover atau fokus keyboard) dan tampilan tabel.
 */
export function DailyChart({ daily }: { daily: DailyPoint[] }) {
  const [metric, setMetric] = useState<Metric>('revenue');
  const [hover, setHover] = useState<number | null>(null);

  const val = (p: DailyPoint) => (metric === 'revenue' ? p.revenue : p.orders);
  const max = niceMax(Math.max(0, ...daily.map(val)));
  const fmt = (n: number) => (metric === 'revenue' ? rupiahShort(n) : num(n));
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const band = iw / daily.length;
  const bw = Math.min(BAR_MAX, band - 6);
  const y = (v: number) => PAD.t + ih - (Math.max(0, v) / max) * ih;
  const total = daily.reduce((a, p) => a + val(p), 0);
  const empty = total <= 0;
  const ticks = empty ? [0] : [0, max / 2, max];
  const hp = hover === null ? null : daily[hover]!;

  return (
    <section className="panel">
      <div className="chart-head">
        <h2 style={{ margin: 0 }}>{metric === 'revenue' ? 'Penerimaan' : 'Pesanan'} per hari · 14 hari terakhir</h2>
        <div className="seg" role="group" aria-label="Ukuran">
          <button type="button" aria-pressed={metric === 'revenue'} onClick={() => setMetric('revenue')}>Penerimaan</button>
          <button type="button" aria-pressed={metric === 'orders'} onClick={() => setMetric('orders')}>Pesanan</button>
        </div>
      </div>
      <p className="muted small" style={{ margin: '0 0 6px' }}>
        {metric === 'revenue' ? 'Pembayaran diterima dikurangi refund; order yang di-void dan makan karyawan tidak dihitung.' : 'Order yang dibayar (sekali per order); order yang di-void dan makan karyawan tidak dihitung.'} Total {fmt(total)}. Batang terakhir adalah hari ini dan belum lengkap.
      </p>
      <div className="chart-scroll">
      <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${metric === 'revenue' ? 'Penerimaan' : 'Pesanan'} per hari, 14 hari terakhir. Total ${fmt(total)}.`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
              <text className="axis-text" x={PAD.l - 8} y={y(t) + 4} textAnchor="end">{fmt(t)}</text>
            </g>
          ))}
          {daily.map((p, i) => {
            const cx = PAD.l + band * i + band / 2;
            const v = val(p);
            const top = y(v);
            const h = PAD.t + ih - top;
            const isToday = i === daily.length - 1;
            const r = Math.min(4, bw / 2, h);
            // Ujung atas membulat 4px, dasar rata.
            const d = h > 0
              ? `M${cx - bw / 2},${PAD.t + ih} V${top + r} Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top} H${cx + bw / 2 - r} Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r} V${PAD.t + ih} Z`
              : `M${cx - bw / 2},${PAD.t + ih - 1} h${bw} v1 h${-bw} Z`;
            return (
              <g key={p.date}>
                <path className={`bar${v > 0 ? '' : ' zero'}`} d={d} />
                {isToday && v > 0 && <text className="axis-text" x={cx} y={top - 5} textAnchor="middle" style={{ fontWeight: 600 }}>{fmt(v)}</text>}
                {(i % 2 === 1 || isToday) && <text className="axis-text" x={cx} y={H - 8} textAnchor="middle">{dayShort(p.date)}</text>}
                {/* Area sentuh selebar satu pita penuh, lebih besar dari batangnya. */}
                <rect
                  className="band" x={cx - band / 2} y={PAD.t} width={band} height={ih + PAD.b} tabIndex={0}
                  aria-label={`${dayLabel(p.date)}: ${num(p.orders)} pesanan, ${rupiah(p.revenue)}`}
                  onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                />
              </g>
            );
          })}
        </svg>
        {hp && hover !== null && (
          <div className="chart-tip" style={{ left: `${((PAD.l + band * hover + band / 2) / W) * 100}%`, top: `${(Math.max(y(val(hp)) - 8, 40) / H) * 100}%` }}>
            <b>{dayLabel(hp.date)}</b>
            {num(hp.orders)} pesanan<br />{rupiah(hp.revenue)}
          </div>
        )}
        {empty && <p className="muted small" style={{ textAlign: 'center', margin: '4px 0 0' }}>Belum ada transaksi dalam 14 hari terakhir.</p>}
      </div>
      </div>
      <details className="table-view">
        <summary>Tampilkan sebagai tabel</summary>
        <table className="table">
          <thead><tr><th>Tanggal</th><th className="num">Pesanan</th><th className="num">Penerimaan</th></tr></thead>
          <tbody>
            {[...daily].reverse().map((p) => (
              <tr key={p.date}><td>{dayLabel(p.date)}</td><td className="num">{num(p.orders)}</td><td className="num">{rupiah(p.revenue)}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
