import { correctedTime, type PosEvent } from '@pos/events';
import { localDate } from './sales-report';

/** Absensi dan penggajian: murni (tanpa database). Waktu dalam ms epoch, uang dalam rupiah. */

export interface Interval {
  staffId: string;
  start: number;
  end: number;
  terminalId: string | null;
  /** Dikoreksi manual oleh manager/owner (mis. lupa absen pulang), bukan dari event terminal. */
  manual: boolean;
  /** Sidik jari foto saat absen masuk dan pulang (bila ada) dan alasan bila tidak ada foto. */
  inPhoto?: string | null;
  outPhoto?: string | null;
  inMissing?: string | null;
  outMissing?: string | null;
}

export interface OpenInterval {
  staffId: string;
  start: number;
  terminalId: string;
  /** Sudah terbuka lebih lama dari batas wajar (lupa absen pulang). */
  stale: boolean;
  inPhoto?: string | null;
  inMissing?: string | null;
}

/** Absen masuk yang belum ditutup lebih dari ini dianggap lupa absen pulang: tidak dihitung gaji sampai dikoreksi. */
export const MAX_OPEN_MS = 16 * 3_600_000;
/** Pembagi gaji bulanan menjadi tarif per jam (jam kerja sebulan menurut ketentuan umum). */
export const MONTHLY_HOURS = 173;

/**
 * Rentang kerja dari event absen: masuk membuka, pulang menutup. Masuk ganda tanpa pulang diabaikan (yang pertama dipakai); pulang tanpa masuk
 * diabaikan. Yang masih terbuka dilaporkan terpisah. Murni dan menerima event semua staf.
 */
export function buildIntervals(events: PosEvent[], now: number): { done: Interval[]; open: OpenInterval[] } {
  const sorted = events.filter((e) => e.type === 'attendance.clocked' && e.actorId).sort((a, b) => correctedTime(a) - correctedTime(b) || a.seq - b.seq);
  const open = new Map<string, { start: number; terminal: string; photo: string | null; missing: string | null }>();
  const done: Interval[] = [];
  for (const e of sorted) {
    if (e.type !== 'attendance.clocked') continue;
    const who = e.actorId!;
    const at = correctedTime(e);
    if (e.payload.kind === 'IN') {
      if (!open.has(who)) open.set(who, { start: at, terminal: e.deviceId, photo: e.payload.photo?.hash ?? null, missing: e.payload.photoMissing ?? null });
    } else {
      const o = open.get(who);
      if (!o) continue;
      if (at > o.start) done.push({ staffId: who, start: o.start, end: at, terminalId: o.terminal, manual: false, inPhoto: o.photo, outPhoto: e.payload.photo?.hash ?? null, inMissing: o.missing, outMissing: e.payload.photoMissing ?? null });
      open.delete(who);
    }
  }
  return {
    done,
    open: [...open].map(([staffId, o]) => ({ staffId, start: o.start, terminalId: o.terminal, stale: now - o.start > MAX_OPEN_MS, inPhoto: o.photo, inMissing: o.missing })),
  };
}

/** Membagi satu rentang kerja menurut hari kalender lokal (lewat tengah malam dipecah) menjadi menit per hari. */
export function splitByDay(start: number, end: number, offsetMinutes: number): { date: string; minutes: number }[] {
  const out: { date: string; minutes: number }[] = [];
  let cur = start;
  while (cur < end) {
    const date = localDate(cur, offsetMinutes);
    const nextMidnight = Date.parse(`${date}T00:00:00Z`) - offsetMinutes * 60_000 + 86_400_000;
    const stop = Math.min(end, nextMidnight);
    const minutes = Math.round((stop - cur) / 60_000);
    if (minutes > 0) out.push({ date, minutes });
    cur = stop;
  }
  return out;
}

export interface PayRule {
  payType: 'HOURLY' | 'MONTHLY';
  /** HOURLY: rupiah per jam. MONTHLY: gaji pokok per periode penggajian. */
  rate: number;
  overtimeMultiplier: number;
}

export interface PayResult {
  regularMinutes: number;
  overtimeMinutes: number;
  base: number;
  overtimePay: number;
  /** Menit kerja per hari lokal (untuk lampiran slip). */
  days: { date: string; minutes: number }[];
}

/**
 * Gaji dari rentang kerja dalam satu periode. Lembur = menit kerja per hari lokal di atas `dailyRegularMinutes` (bawaan 8 jam).
 * Per jam: pokok = jam reguler × tarif. Bulanan: pokok = gaji tetap; tarif lembur = gaji ÷ 173 jam.
 */
export function computePay(intervals: Pick<Interval, 'start' | 'end'>[], rule: PayRule, offsetMinutes: number, dailyRegularMinutes = 480): PayResult {
  const perDay = new Map<string, number>();
  for (const i of intervals) for (const d of splitByDay(i.start, i.end, offsetMinutes)) perDay.set(d.date, (perDay.get(d.date) ?? 0) + d.minutes);
  let regular = 0;
  let overtime = 0;
  for (const m of perDay.values()) {
    regular += Math.min(m, dailyRegularMinutes);
    overtime += Math.max(0, m - dailyRegularMinutes);
  }
  const hourly = rule.payType === 'HOURLY' ? rule.rate : rule.rate / MONTHLY_HOURS;
  return {
    regularMinutes: regular,
    overtimeMinutes: overtime,
    base: rule.payType === 'HOURLY' ? Math.round((regular / 60) * rule.rate) : rule.rate,
    overtimePay: Math.round((overtime / 60) * hourly * rule.overtimeMultiplier),
    days: [...perDay].sort((a, b) => a[0].localeCompare(b[0])).map(([date, minutes]) => ({ date, minutes })),
  };
}

export const netPay = (base: number, overtimePay: number, allowance: number, deduction: number): number => Math.max(0, base + overtimePay + allowance - deduction);
