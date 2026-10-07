/** Fungsi tampilan murni, aman dipakai di komponen klien (tidak menyentuh next/headers). */
const DAY_MS = 86_400_000;
export function ago(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return 'baru saja';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} mnt lalu`;
  if (diff < DAY_MS) return `${Math.floor(diff / 3_600_000)} jam lalu`;
  return `${Math.floor(diff / DAY_MS)} hari lalu`;
}

export const dateWib = (iso: string) =>
  new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const nf = new Intl.NumberFormat('id-ID');
export const num = (n: number) => nf.format(Math.round(n));

/** Rupiah ringkas untuk kartu dan sumbu: 12,5 rb · 3,4 jt · 1,2 M. Angka penuh tersedia di tooltip dan tabel. */
export function rupiahShort(n: number): string {
  const sign = n < 0 ? '-' : '';
  const v = Math.abs(n);
  const f = (x: number, unit: string) => `${sign}Rp ${x.toLocaleString('id-ID', { maximumFractionDigits: x < 10 ? 1 : 0 })} ${unit}`;
  if (v >= 1e9) return f(v / 1e9, 'M');
  if (v >= 1e6) return f(v / 1e6, 'jt');
  if (v >= 1e3) return f(v / 1e3, 'rb');
  return `${sign}Rp ${Math.round(v)}`;
}
export const rupiah = (n: number) => `${n < 0 ? '-' : ''}Rp ${nf.format(Math.abs(Math.round(n)))}`;

const DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
/** "2026-10-07" -> "Rab, 7 Okt". Tanggal sudah lokal outlet, jadi dibaca sebagai UTC agar tidak bergeser. */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
export const dayShort = (date: string) => String(new Date(`${date}T00:00:00Z`).getUTCDate());

/** Skala sumbu yang rapi (1-2-5) dan tiga tanda: 0, setengah, maksimum. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}
