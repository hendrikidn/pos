const WIB_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** "01 Okt 2026" */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

function parts(ms: number) {
  const d = new Date(ms + WIB_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}

/** Jam WIB "13:14" atau "13:14:02" */
export function wibClock(ms: number, withSeconds = false): string {
  const p = parts(ms);
  return `${pad(p.h)}:${pad(p.mi)}${withSeconds ? `:${pad(p.s)}` : ''}`;
}

export function wibDate(ms: number): string {
  const p = parts(ms);
  return `${pad(p.d)} ${MONTHS[p.mo]} ${p.y}`;
}

export function wibDateTime(ms: number, withSeconds = false): string {
  return `${wibDate(ms)}, ${wibClock(ms, withSeconds)} WIB`;
}

/** "01 Okt 2026, 13:14–13:18 WIB" (tanggal sekali bila awal dan akhir di hari yang sama) */
export function wibRange(startMs: number, endMs: number): string {
  const a = parts(startMs);
  const b = parts(endMs);
  const sameDay = a.y === b.y && a.mo === b.mo && a.d === b.d;
  return sameDay
    ? `${wibDate(startMs)}, ${wibClock(startMs)}–${wibClock(endMs)} WIB`
    : `${wibDateTime(startMs)} – ${wibDateTime(endMs)}`;
}

/** Selisih dalam bentuk ringkas: "5 mnt", "2 jam", "3 hari" */
export function ago(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return 'baru saja';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} mnt lalu`;
  if (diff < DAY_MS) return `${Math.floor(diff / 3_600_000)} jam lalu`;
  return `${Math.floor(diff / DAY_MS)} hari lalu`;
}

export interface CctvInfo {
  /** Jendela rekaman yang perlu diperiksa, sudah dikoreksi selisih jam NVR (epoch ms menurut jam NVR) */
  fromMs: number;
  toMs: number;
  /** Batas perkiraan rekaman masih ada */
  retainedUntilMs: number;
  /** Sisa hari penuh sampai rekaman diperkirakan tertimpa; negatif jika sudah lewat */
  daysLeft: number;
  status: 'OK' | 'URGENT' | 'EXPIRED';
}

export const CCTV_PADDING_MS = 2 * 60_000;
export const URGENT_DAYS = 2;

/**
 * Jendela rekaman untuk satu insiden: dua menit sebelum dan sesudah kejadian.
 * Perkiraan retensi dihitung dari awal kejadian, karena rekaman SD card menimpa yang tertua lebih dulu.
 * `clockOffsetSec` positif berarti jam NVR lebih cepat dari jam sebenarnya.
 */
export function cctvInfo(
  startMs: number, endMs: number, retentionDays: number, clockOffsetSec: number, now: number,
): CctvInfo {
  const offset = clockOffsetSec * 1000;
  const retainedUntilMs = startMs + retentionDays * DAY_MS;
  const daysLeft = Math.floor((retainedUntilMs - now) / DAY_MS);
  return {
    fromMs: startMs - CCTV_PADDING_MS + offset,
    toMs: endMs + CCTV_PADDING_MS + offset,
    retainedUntilMs,
    daysLeft,
    status: retainedUntilMs <= now ? 'EXPIRED' : daysLeft < URGENT_DAYS ? 'URGENT' : 'OK',
  };
}

export const LEVEL_LABEL = { CRITICAL: 'Kritis', MEDIUM: 'Sedang', LOW: 'Rendah' } as const;

export const STATUS_LABEL: Record<string, string> = {
  OPEN: 'Perlu review',
  RETRACTED: 'Dibatalkan data susulan',
  CONFIRMED_FRAUD: 'Terbukti',
  LEGIT: 'Sah',
  FALSE_ALARM: 'Alarm palsu',
  INCONCLUSIVE: 'Belum bisa disimpulkan',
};

export const REVIEW_OPTIONS = [
  { value: 'CONFIRMED_FRAUD', label: 'Terbukti kecurangan', hint: 'CCTV menunjukkan customer membayar tetapi tidak tercatat' },
  { value: 'LEGIT', label: 'Sah', hint: 'Transaksi wajar setelah dicek CCTV' },
  { value: 'FALSE_ALARM', label: 'Alarm palsu', hint: 'Sistem salah, mis. sensor atau data terlambat' },
  { value: 'INCONCLUSIVE', label: 'Belum bisa disimpulkan', hint: 'Rekaman tidak ada atau tidak jelas' },
] as const;

export const CHANNEL_LABEL: Record<string, string> = {
  QRIS: 'QRIS', CARD_DEBIT: 'Kartu debit', CARD_CREDIT: 'Kartu kredit', OTHER: 'Lainnya (NPG)',
};

/** Batch EDC yang belum ditutup lebih dari ini dianggap terlambat (kasir seharusnya menutup tiap hari). */
export const BATCH_OVERDUE_MS = 30 * 3_600_000;

// ---------- laporan penjualan ----------

/** "Rp 1.234.567"; negatif ditulis "−Rp 5.000". */
export function rp(n: number): string {
  const s = Math.abs(Math.round(n)).toLocaleString('id-ID');
  return `${n < 0 ? '−' : ''}Rp ${s}`;
}

/** Ringkas untuk sumbu dan ubin: "Rp 850 rb", "Rp 1,2 jt", "Rp 3 M". */
export function rpCompact(n: number): string {
  const sign = n < 0 ? '−' : '';
  const a = Math.abs(n);
  const fmt = (v: number) => (Math.round(v * 10) / 10).toLocaleString('id-ID', { maximumFractionDigits: 1 });
  if (a >= 1e9) return `${sign}Rp ${fmt(a / 1e9)} M`;
  if (a >= 1e6) return `${sign}Rp ${fmt(a / 1e6)} jt`;
  if (a >= 1e3) return `${sign}Rp ${fmt(a / 1e3)} rb`;
  return `${sign}Rp ${Math.round(a)}`;
}

/** Batas atas sumbu yang "bulat" (1, 2, 2,5, 5 × 10^k) dan selalu ≥ nilai maksimum. Nol atau negatif menghasilkan 1. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  for (const m of [1, 2, 2.5, 5, 10]) if (m * base >= v) return m * base;
  return 10 * base;
}

const DAYS_ID = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

/** Tanggal kalender "YYYY-MM-DD" (tanpa zona waktu). */
function ymd(date: string) {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/** "1 Okt" */
export const shortDate = (date: string): string => { const p = ymd(date); return `${p.d} ${MONTHS[p.m - 1]}`; };
/** "Sen, 1 Okt" */
export const weekdayDate = (date: string): string => { const p = ymd(date); return `${DAYS_ID[p.dow]}, ${p.d} ${MONTHS[p.m - 1]}`; };

/** "1 Okt 2026", "1–7 Okt 2026", atau "28 Sep – 4 Okt 2026". */
export function rangeText(from: string, to: string): string {
  const a = ymd(from);
  const b = ymd(to);
  if (from === to) return `${a.d} ${MONTHS[a.m - 1]} ${a.y}`;
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
  return `${a.d} ${MONTHS[a.m - 1]}${a.y === b.y ? '' : ` ${a.y}`} – ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
}

export const RANGE_OPTIONS = [
  { value: 'today', label: 'Hari ini' },
  { value: 'yesterday', label: 'Kemarin' },
  { value: '7d', label: '7 hari' },
  { value: '30d', label: '30 hari' },
  { value: 'month', label: 'Bulan ini' },
] as const;
export type RangeValue = (typeof RANGE_OPTIONS)[number]['value'];
