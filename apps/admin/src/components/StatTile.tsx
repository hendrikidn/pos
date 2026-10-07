import type { ReactNode } from 'react';

/** Kartu angka tunggal: label (kalimat biasa), nilai, dan keterangan pembanding. `tone` hanya menandai kondisi, bukan sekadar hiasan. */
export function StatTile({ label, value, sub, tone, title }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'warn' | 'bad'; title?: string }) {
  return (
    <div className={`tile${tone ? ` ${tone}` : ''}`} title={title}>
      <p className="label">{label}</p>
      <p className="value">{value}</p>
      {sub !== undefined && <p className="sub">{sub}</p>}
    </div>
  );
}
