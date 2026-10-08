'use client';

import { useId, useState } from 'react';
import { niceMax, rp, rpCompact } from '@/lib/format';

export interface Bar {
  /** Teks di sumbu X (boleh dikosongkan agar tidak bertabrakan) dan nama penuh untuk tooltip/tabel. */
  axis: string;
  label: string;
  value: number;
  /** Keterangan tambahan di tooltip, mis. "3 order". */
  detail?: string;
  /** Nilai pembanding (mis. periode sebelumnya) pada posisi yang sama: digambar sebagai garis tipis di atas batang. */
  ghost?: number;
}

const HEIGHT = 180;

/**
 * Grafik kolom satu seri (satu warna). Batang tipis dengan ujung atas membulat dan dasar rata, tooltip saat disentuh
 * atau difokus, nilai tertinggi diberi label, dan tabel alternatif untuk pembaca layar. Nilai negatif digambar
 * sebagai nol (tooltip dan tabel tetap menampilkan angka sebenarnya).
 */
export function BarChart({ title, data, unit, empty, unitLabel = 'order' }: { title: string; data: Bar[]; unit: 'rp' | 'n'; empty: string; unitLabel?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const fmt = (v: number) => (unit === 'rp' ? rp(v) : `${v.toLocaleString('id-ID')} ${unitLabel}`);
  const fmtAxis = (v: number) => (unit === 'rp' ? (v === 0 ? '0' : rpCompact(v).replace('Rp ', '')) : String(v));
  const max = Math.max(0, ...data.map((d) => d.value));
  const hasGhost = data.some((d) => d.ghost !== undefined);
  const scaleMax = Math.max(max, ...data.map((d) => d.ghost ?? 0));
  if (max === 0 && scaleMax === 0) return <div className="empty">{empty}</div>;

  const top = niceMax(scaleMax);
  const maxIndex = data.findIndex((d) => d.value === max);
  const pct = (v: number) => `${(Math.max(0, v) / top) * 100}%`;
  const edge = hover === null ? '' : hover < data.length * 0.2 ? 'left' : hover > data.length * 0.8 ? 'right' : '';

  return (
    <figure className="chart" aria-label={title}>
      <div className="chart-body">
        <div className="chart-y" aria-hidden="true">
          {[1, 0.5, 0].map((f) => (
            <span key={f} style={{ bottom: `${f * 100}%` }}>{fmtAxis(top * f)}</span>
          ))}
        </div>
        <div className="chart-plot" style={{ height: HEIGHT }} onPointerLeave={() => setHover(null)}>
          {[1, 0.5, 0].map((f) => <i key={f} className="chart-grid" style={{ bottom: `${f * 100}%` }} aria-hidden="true" />)}
          <div className="chart-cols">
            {data.map((d, i) => (
              <button
                key={d.label}
                type="button"
                className={`chart-col ${hover === i ? 'on' : ''}`}
                aria-label={`${d.label}: ${fmt(d.value)}${d.detail ? `, ${d.detail}` : ''}${d.ghost !== undefined ? `, sebelumnya ${fmt(d.ghost)}` : ''}`}
                onPointerEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              >
                {d.ghost !== undefined && <i className="chart-ghost" style={{ bottom: pct(d.ghost) }} aria-hidden="true" />}
                <span className="chart-bar" style={{ height: pct(d.value) }}>
                  {i === maxIndex && hover === null && <b className="chart-cap">{unit === 'rp' ? rpCompact(d.value) : d.value}</b>}
                </span>
              </button>
            ))}
          </div>
          {hover !== null && data[hover] && (
            <div className={`chart-tip ${edge}`} style={edge ? undefined : { left: `${((hover + 0.5) / data.length) * 100}%` }} role="status">
              <strong>{fmt(data[hover]!.value)}</strong>
              <span>{data[hover]!.label}</span>
              {data[hover]!.detail && <span>{data[hover]!.detail}</span>}
              {data[hover]!.ghost !== undefined && <span>Sebelumnya: {fmt(data[hover]!.ghost!)}</span>}
            </div>
          )}
        </div>
      </div>
      <div className="chart-x" aria-hidden="true">
        {data.map((d) => <span key={d.label}>{d.axis}</span>)}
      </div>
      {hasGhost && <p className="chart-legend small muted"><i className="chart-ghost-key" aria-hidden="true" /> Garis = periode sebelumnya, pada urutan hari yang sama</p>}
      <details className="chart-table">
        <summary>Lihat sebagai tabel</summary>
        <table className="table" aria-labelledby={id}>
          <thead id={id}><tr><th>{title}</th><th className="num">Nilai</th>{hasGhost && <th className="num">Sebelumnya</th>}</tr></thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.label}>
                <td data-label="Waktu">{d.label}</td>
                <td className="num" data-label="Nilai">{fmt(d.value)}{d.detail ? ` · ${d.detail}` : ''}</td>
                {hasGhost && <td className="num" data-label="Sebelumnya">{d.ghost !== undefined ? fmt(d.ghost) : '–'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
