import { ruleLabel } from '@pos/rules';
import { addDays, DAY_MS, localDate } from './sales-report';

/** Lama mode shadow bawaan untuk outlet baru (SPEC 8). */
export const DEFAULT_SHADOW_DAYS = 14;

/** Event yang menandakan outlet benar-benar mulai beroperasi. Heartbeat dan postur perangkat tidak dihitung. */
export const GO_LIVE_TYPES = ['order.created', 'payment.received', 'presence.session'] as const;

/** Awal shadow boleh mundur sampai sejauh ini (event yang tertahan di perangkat offline), dan tidak boleh di masa depan. */
export const MAX_BACKDATE_MS = 2 * DAY_MS;

export interface ShadowState {
  days: number;
  /** Outlet memakai mode shadow (days > 0). */
  enabled: boolean;
  /** Sedang berlaku: insiden dicatat tetapi tidak dikirim. */
  active: boolean;
  /** Belum ada aktivitas pertama, jadi hitungan hari belum mulai. */
  pending: boolean;
  startedMs: number | null;
  untilMs: number | null;
  /** Hari ke-N (1..days) selama berlaku; 0 saat menunggu; `days` setelah selesai. */
  day: number;
}

export function shadowState(days: number, startedMs: number | null, now: number): ShadowState {
  if (days <= 0) return { days: 0, enabled: false, active: false, pending: false, startedMs, untilMs: null, day: 0 };
  if (startedMs === null) return { days, enabled: true, active: true, pending: true, startedMs: null, untilMs: null, day: 0 };
  const untilMs = startedMs + days * DAY_MS;
  const active = now < untilMs;
  const day = active ? Math.min(days, Math.max(0, Math.floor((now - startedMs) / DAY_MS)) + 1) : days;
  return { days, enabled: true, active, pending: false, startedMs, untilMs, day };
}

/** Waktu mulai shadow dari event pertama yang bermakna: dibatasi ke [now − 2 hari, now]. */
export function clampShadowStart(firstEventMs: number, now: number): number {
  return Math.min(now, Math.max(now - MAX_BACKDATE_MS, firstEventMs));
}

export interface ShadowIncident {
  id: string;
  start_ms: number;
  level: 'LOW' | 'MEDIUM' | 'CRITICAL';
  status: string;
  hits: { rule: string }[];
}

export interface ShadowSummary {
  total: number;
  byLevel: { CRITICAL: number; MEDIUM: number; LOW: number };
  /** Jumlah insiden yang memuat aturan itu (satu insiden bisa memuat beberapa aturan). */
  byRule: { rule: string; label: string; incidents: number }[];
  byDay: { date: string; total: number; critical: number }[];
  /** Perkiraan insiden kritis per minggu (null bila belum cukup 3 hari data). Target pilot: ≤ 3 (SPEC 12). */
  criticalPerWeek: number | null;
  /** Insiden yang sudah direview owner selama shadow, untuk menilai presisi. */
  reviewed: { total: number; confirmed: number; legit: number; falseAlarm: number; inconclusive: number };
  /** Kritis yang dikonfirmasi / kritis yang direview. Null bila belum ada yang direview. Target pilot: ≥ 30%. */
  criticalPrecision: number | null;
}

/**
 * Ringkasan "apa yang akan terdeteksi": hanya insiden shadow, tanpa yang ditarik kembali oleh data susulan.
 * `now` dan `utcOffsetMinutes` menentukan rentang hari yang ditampilkan.
 */
export function buildShadowSummary(
  incidents: ShadowIncident[], state: ShadowState, now: number, utcOffsetMinutes: number,
): ShadowSummary {
  const live = incidents.filter((i) => i.status !== 'RETRACTED');
  const byLevel = { CRITICAL: 0, MEDIUM: 0, LOW: 0 };
  const rules = new Map<string, number>();
  const days = new Map<string, { total: number; critical: number }>();

  if (state.startedMs !== null) {
    const end = localDate(Math.min(now, state.untilMs ?? now), utcOffsetMinutes);
    for (let d = localDate(state.startedMs, utcOffsetMinutes); d <= end; d = addDays(d, 1)) days.set(d, { total: 0, critical: 0 });
  }

  const reviewed = { total: 0, confirmed: 0, legit: 0, falseAlarm: 0, inconclusive: 0 };
  let criticalReviewed = 0;
  let criticalConfirmed = 0;
  for (const i of live) {
    byLevel[i.level]++;
    for (const r of new Set(i.hits.map((h) => h.rule))) rules.set(r, (rules.get(r) ?? 0) + 1);
    const day = days.get(localDate(i.start_ms, utcOffsetMinutes)) ?? days.set(localDate(i.start_ms, utcOffsetMinutes), { total: 0, critical: 0 }).get(localDate(i.start_ms, utcOffsetMinutes))!;
    day.total++;
    if (i.level === 'CRITICAL') day.critical++;
    if (i.status !== 'OPEN') {
      reviewed.total++;
      if (i.status === 'CONFIRMED_FRAUD') reviewed.confirmed++;
      else if (i.status === 'LEGIT') reviewed.legit++;
      else if (i.status === 'FALSE_ALARM') reviewed.falseAlarm++;
      else reviewed.inconclusive++;
      if (i.level === 'CRITICAL') {
        criticalReviewed++;
        if (i.status === 'CONFIRMED_FRAUD') criticalConfirmed++;
      }
    }
  }

  const elapsedDays = state.startedMs === null ? 0 : (Math.min(now, state.untilMs ?? now) - state.startedMs) / DAY_MS;
  return {
    total: live.length,
    byLevel,
    byRule: [...rules].map(([rule, n]) => ({ rule, label: ruleLabel(rule), incidents: n })).sort((a, b) => b.incidents - a.incidents || a.rule.localeCompare(b.rule)),
    byDay: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
    criticalPerWeek: elapsedDays >= 3 ? Math.round(((byLevel.CRITICAL * 7) / elapsedDays) * 10) / 10 : null,
    reviewed,
    criticalPrecision: criticalReviewed > 0 ? Math.round((criticalConfirmed / criticalReviewed) * 100) : null,
  };
}
