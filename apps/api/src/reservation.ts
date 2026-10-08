/** Aturan reservasi yang murni (tanpa database): bentrok meja, sisa uang muka, dan pemeriksaan pemakaian uang muka. */

export const DEFAULT_DURATION_MIN = 90;
export const MAX_PARTY = 50;
export const MAX_DEPOSIT = 50_000_000;
export const HORIZON_DAYS = 180;
/** Tamu baru boleh ditandai tidak datang setelah lewat dari jam reservasi sekian lama. */
export const NO_SHOW_GRACE_MS = 15 * 60_000;
/** Tamu boleh didudukkan paling cepat sekian lama sebelum jam reservasi. */
export const SEAT_EARLY_MS = 2 * 3_600_000;
/** Uang muka yang belum dipertanggungjawabkan sekian lama setelah reservasi berakhir/dibatalkan menjadi temuan (R44). */
export const UNSETTLED_AFTER_MS = 24 * 3_600_000;
/** Pemakaian uang muka lebih dari ini sebelum/sesudah jam reservasi dianggap janggal (R43). */
export const USE_WINDOW_MS = 12 * 3_600_000;

export type ReservationStatus = 'BOOKED' | 'SEATED' | 'NO_SHOW' | 'CANCELED';
export type SettleKind = 'REFUND' | 'FORFEIT';

export interface ReservationFacts {
  id: number;
  status: ReservationStatus;
  startMs: number;
  durationMin: number;
  deposit: number;
  depositAtMs: number | null;
  depositBy: string | null;
  statusAtMs: number | null;
  settleKind: SettleKind | null;
  settleAtMs: number | null;
}

export const endMs = (r: { startMs: number; durationMin: number }) => r.startMs + r.durationMin * 60_000;

/** Dua rentang waktu bentrok bila saling menimpa (bersentuhan di ujung tidak bentrok). */
export const overlaps = (a: { startMs: number; durationMin: number }, b: { startMs: number; durationMin: number }) => a.startMs < endMs(b) && b.startMs < endMs(a);

/** Sisa uang muka yang masih ditahan: dikurangi yang sudah dipakai sebagai pembayaran, dan nol bila sudah dikembalikan/dihanguskan. */
export function depositRemaining(r: Pick<ReservationFacts, 'deposit' | 'settleKind'>, applied: number): number {
  return r.settleKind ? 0 : Math.max(0, r.deposit - applied);
}

/**
 * Memeriksa satu pembayaran dengan uang muka: kembali alasan bila tidak sah (dasar aturan R43), atau null.
 * `appliedBefore` = jumlah pembayaran uang muka lain untuk reservasi yang sama yang terjadi lebih dulu.
 */
export function checkDepositPayment(r: ReservationFacts | undefined, appliedBefore: number, amount: number, at: number, reservationId: number): string | null {
  if (!r) return `reservasi #${reservationId} tidak ada di outlet ini`;
  if (r.deposit <= 0 || r.depositAtMs === null) return `reservasi #${r.id} tidak punya uang muka`;
  if (at < r.depositAtMs - 60_000) return `uang muka reservasi #${r.id} dipakai sebelum dicatat diterima`;
  if (r.settleKind && r.settleAtMs !== null && at >= r.settleAtMs) return `uang muka reservasi #${r.id} sudah ${r.settleKind === 'REFUND' ? 'dikembalikan' : 'dihanguskan'}`;
  if ((r.status === 'CANCELED' || r.status === 'NO_SHOW') && r.statusAtMs !== null && at >= r.statusAtMs) return `reservasi #${r.id} sudah ${r.status === 'CANCELED' ? 'dibatalkan' : 'ditandai tidak datang'}`;
  if (r.status === 'BOOKED') return `uang muka reservasi #${r.id} dipakai padahal tamunya belum didudukkan`;
  if (appliedBefore + amount > r.deposit) return `pemakaian uang muka reservasi #${r.id} melebihi uang muka (Rp ${r.deposit.toLocaleString('id-ID')}, terpakai Rp ${appliedBefore.toLocaleString('id-ID')}, kini Rp ${amount.toLocaleString('id-ID')})`;
  if (at < r.startMs - USE_WINDOW_MS || at > endMs(r) + USE_WINDOW_MS) return `uang muka reservasi #${r.id} dipakai jauh di luar jam reservasi`;
  return null;
}

/** Saat uang muka yang tidak dipertanggungjawabkan menjadi temuan (R44), atau null bila tidak ada yang menggantung. */
export function unsettledDeadline(r: ReservationFacts, applied: number): number | null {
  if (depositRemaining(r, applied) <= 0) return null;
  const base = (r.status === 'CANCELED' || r.status === 'NO_SHOW') && r.statusAtMs !== null ? r.statusAtMs : endMs(r);
  return base + UNSETTLED_AFTER_MS;
}
