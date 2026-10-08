/** Aturan penagihan langganan. Murni (tanpa database): tanggal lokal WIB berbentuk YYYY-MM-DD. */

export const TRIAL_DAYS = 14;
/** Tagihan periode berikutnya diterbitkan sekian hari sebelum periodenya mulai. */
export const BILL_AHEAD_DAYS = 7;
/** Setelah jatuh tempo, langganan dianggap tertunggak sesudah sekian hari. */
export const GRACE_DAYS = 7;
export const BILLING_UTC_OFFSET_MINUTES = 420;

const DAY_MS = 86_400_000;

export const billingDate = (ms: number): string => new Date(ms + BILLING_UTC_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
export const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Tanggal `anchor` digeser n bulan; hari dipertahankan dan dipotong ke akhir bulan (31 Jan + 1 bulan = 28/29 Feb, tanpa menggeser jangkar). */
export function addMonths(anchor: string, n: number): string {
  const [y, m, d] = anchor.split('-').map(Number) as [number, number, number];
  const idx = y * 12 + (m - 1) + n;
  const year = Math.floor(idx / 12);
  const month = idx % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Periode ke-k (0, 1, …) sejak jangkar: [mulai, akhir] inklusif. */
export function periodOf(anchor: string, k: number): { start: string; end: string } {
  return { start: addMonths(anchor, k), end: addDays(addMonths(anchor, k + 1), -1) };
}

/**
 * Nomor periode yang harus sudah ditagih pada `today`: semua periode dengan awal ≤ today + BILL_AHEAD_DAYS, dimulai dari `fromK`.
 * Dipakai agar penerbitan idempoten: yang sudah ada tidak diterbitkan lagi.
 */
export function periodsToIssue(anchor: string, today: string, fromK: number): number[] {
  const out: number[] = [];
  for (let k = fromK; k < fromK + 24; k++) {
    if (addDays(periodOf(anchor, k).start, -BILL_AHEAD_DAYS) > today) break;
    out.push(k);
  }
  return out;
}

export type SubscriptionStatus = 'TRIAL' | 'ACTIVE' | 'DUE' | 'OVERDUE' | 'CANCELED';

export interface InvoiceLite {
  status: 'ISSUED' | 'PAID' | 'VOID';
  periodStart: string;
  periodEnd: string;
  dueDate: string;
}

/**
 * Status langganan pada `today`:
 *  - CANCELED: dihentikan.
 *  - TRIAL: masa uji coba berjalan dan belum ada periode berbayar.
 *  - OVERDUE: ada tagihan belum dibayar yang lewat jatuh tempo lebih dari GRACE_DAYS.
 *  - ACTIVE: hari ini tercakup periode yang sudah dibayar.
 *  - DUE: sudah ada tagihan menunggu (belum lewat masa tenggang) atau periode berbayar habis tanpa tagihan baru.
 */
export function subscriptionStatus(sub: { status: 'TRIAL' | 'ACTIVE' | 'CANCELED'; trialEnd: string }, invoices: InvoiceLite[], today: string): SubscriptionStatus {
  if (sub.status === 'CANCELED') return 'CANCELED';
  const live = invoices.filter((i) => i.status !== 'VOID');
  if (live.some((i) => i.status === 'ISSUED' && addDays(i.dueDate, GRACE_DAYS) < today)) return 'OVERDUE';
  const covered = live.some((i) => i.status === 'PAID' && i.periodStart <= today && today <= i.periodEnd);
  if (covered) return 'ACTIVE';
  if (today <= sub.trialEnd && !live.some((i) => i.status === 'PAID')) return 'TRIAL';
  return 'DUE';
}

/** Tanggal jatuh tempo tagihan: awal periodnya, tetapi paling cepat 7 hari sejak diterbitkan. */
export function dueDateFor(periodStart: string, issuedDate: string): string {
  const min = addDays(issuedDate, 7);
  return periodStart > min ? periodStart : min;
}

export const invoiceNumber = (date: string, seq: number): string => `INV-${date.slice(0, 4)}${date.slice(5, 7)}-${String(seq).padStart(4, '0')}`;
