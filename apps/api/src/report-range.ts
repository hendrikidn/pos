import { BadRequestException } from '@nestjs/common';
import { addDays, DAY_MS, localDate } from './sales-report';

export const MAX_REPORT_DAYS = 31;
const DEFAULT_DAYS = 7;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const RANGES = ['today', 'yesterday', '7d', '30d', 'month'] as const;
export type RangePreset = (typeof RANGES)[number];

function presetRange(r: RangePreset, today: string): { from: string; to: string } {
  switch (r) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: addDays(today, -1), to: addDays(today, -1) };
    case '7d': return { from: addDays(today, -6), to: today };
    case '30d': return { from: addDays(today, -29), to: today };
    case 'month': return { from: `${today.slice(0, 8)}01`, to: today };
  }
}

/** Tanggal kalender yang sah (menolak 2026-02-30 dan 2026-13-01; yang terakhir membuat toISOString melempar kesalahan). */
const validDate = (s: string): boolean => {
  if (!DATE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};

/** Rentang tanggal lokal dari `from`/`to` atau preset `range` (today, yesterday, 7d, 30d, month), lengkap dengan pemeriksaannya. */
export function resolveRange(off: number, params: { from?: string; to?: string; range?: string }, now: number): { from: string; to: string; days: number; today: string } {
  const today = localDate(now, off);
  let { from, to } = params;
  if (params.range !== undefined) {
    if (from !== undefined || to !== undefined) throw new BadRequestException('pakai range atau from/to, tidak keduanya');
    if (!(RANGES as readonly string[]).includes(params.range)) throw new BadRequestException(`range harus salah satu dari ${RANGES.join(', ')}`);
    ({ from, to } = presetRange(params.range as RangePreset, today));
  }
  to = to ?? today;
  from = from ?? addDays(to, -(DEFAULT_DAYS - 1));
  if (!validDate(from) || !validDate(to)) throw new BadRequestException('tanggal harus berformat YYYY-MM-DD');
  if (from > to) throw new BadRequestException('tanggal awal tidak boleh setelah tanggal akhir');
  if (to > today) throw new BadRequestException('tanggal akhir tidak boleh di masa depan');
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > MAX_REPORT_DAYS) throw new BadRequestException(`rentang maksimal ${MAX_REPORT_DAYS} hari`);
  return { from, to, days, today };
}
