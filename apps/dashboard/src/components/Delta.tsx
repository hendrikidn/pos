import type { Change } from '@/lib/api';
import { pctText } from '@/lib/format';

/**
 * Perubahan terhadap periode sebelumnya. `bad`: angka naik = buruk (refund, void, diskon): naik berwarna merah, turun hijau.
 * `inline`: sudah diikuti kalimat "dibanding …" sehingga teks tambahan pembaca layar tidak perlu. Persen kosong (periode sebelumnya nol) ditulis "baru" agar tidak muncul angka tak terhingga.
 */
export function Delta({ change, bad = false, amount, inline = false }: { change: Change; bad?: boolean; amount?: (n: number) => string; inline?: boolean }) {
  if (change.delta === 0) return <small className="delta flat">Sama seperti sebelumnya</small>;
  const up = change.delta > 0;
  const tone = up === bad ? 'neg' : 'pos';
  const text = change.pct === null ? 'baru' : pctText(change.pct);
  const extra = amount ? ` (${up ? '+' : '−'}${amount(Math.abs(change.delta))})` : '';
  return (
    <small className={`delta ${tone}`}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span> {text}{extra}
      {!inline && <span className="sr-only"> {up ? 'naik' : 'turun'} dibanding periode sebelumnya</span>}
    </small>
  );
}
