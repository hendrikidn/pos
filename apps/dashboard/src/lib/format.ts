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
