import type { PosEvent } from '@pos/events';

export type Modality = 'PHYSICAL' | 'POS' | 'BANK';

export interface RuleHit {
  rule: string;
  /** Kunci unik (rule + subjek). Evaluasi ulang menghasilkan kunci yang sama, jadi tidak ada duplikat. */
  key: string;
  weight: number;
  modalities: Modality[];
  outletId: string;
  terminalId: string | null;
  orderId: string | null;
  actorIds: string[];
  /** Waktu kejadian (epoch ms, sudah dikoreksi) */
  at: number;
  windowStart: number;
  windowEnd: number;
  /** Hit berbasis kondisi berkelanjutan (printer habis kertas, sensor mati). Melekat ke insiden lain yang beririsan. */
  context: boolean;
  confidence: 'HIGH' | 'LOW';
  note: string;
  /** Pembayaran yang mungkin terkait (mis. kandidat selisih settlement), untuk dicek di CCTV. */
  evidence?: { orderId: string; at: number; amount: number; terminalId: string | null; actorId: string | null }[];
}

export interface Capabilities {
  sensor: boolean;
  /** Outlet memakai KDS. Tanpa KDS, "sudah diproduksi" dihampiri dari waktu sejak dikirim ke dapur. */
  kds: boolean;
  /** Printer melaporkan status kertas sendiri. */
  printerReportsStatus: boolean;
}

export interface RuleConfig {
  r1MinPresenceMs: number;
  r1OrderWindowMs: number;
  r2ProxyDelayMs: number;
  r3AfterPresenceMs: number;
  r5PaperOutMs: number;
  r21ToleranceMs: number;
  r25Run: number;
  r4GapMs: number;
  /** Setelah ini, aturan "tidak ada event" dievaluasi walau terminal belum mengirim data susulan. */
  lateGraceMs: number;
  linkPadMs: number;
  discountMaxPercent: number;
  discountMaxAmount: number;
  /** R6: jumlah makan karyawan gratis per orang per hari lokal. Yang ke-(kuota+1) dan seterusnya ditandai. */
  r6DailyQuota: number;
  /** R14: selisih blind count (rupiah, mutlak) yang masih ditoleransi. */
  r14ToleranceAmount: number;
  /** R14: ditandai bila shift menyimpang lebih dari ini dalam `r14WindowMs`. */
  r14MaxShifts: number;
  r14WindowMs: number;
  weights: Record<string, number>;
}

export const DEFAULT_CONFIG: RuleConfig = {
  r1MinPresenceMs: 45_000,
  r1OrderWindowMs: 3 * 60_000,
  r2ProxyDelayMs: 5 * 60_000,
  r3AfterPresenceMs: 60_000,
  r5PaperOutMs: 15 * 60_000,
  r21ToleranceMs: 2 * 60_000,
  r25Run: 5,
  r4GapMs: 5 * 60_000,
  lateGraceMs: 30 * 60_000,
  linkPadMs: 15_000,
  discountMaxPercent: 15,
  discountMaxAmount: 50_000,
  r6DailyQuota: 1,
  r14ToleranceAmount: 5_000,
  r14MaxShifts: 3,
  r14WindowMs: 7 * 24 * 3_600_000,
  weights: {
    R1: 15, R1_DRAWER: 30, R2: 30, R2_PROXY: 20, R3: 35, R4: 40, R5: 20, R5B: 25, R6: 25, R6_APPROVED: 10, R14: 20,
    R18: 30, R18_APPROVED: 10, R21: 30, R22: 30, R23: 20, R24: 40, R25: 25, R30: 60, R30_UNTRACKED: 20, R29_TIME: 30, R29_DEBUG: 15, R29_ROOT: 40,
  },
};

export interface RuleInput {
  events: PosEvent[];
  /** Waktu evaluasi (epoch ms) */
  now: number;
  /** ID perangkat terminal POS di outlet */
  terminals: string[];
  capabilities: Capabilities;
  config?: Partial<RuleConfig>;
  /** Offset zona waktu outlet (menit) untuk batas "hari" pada kuota R6. Default WIB. */
  utcOffsetMinutes?: number;
  /** Masalah integritas yang hanya diketahui server (mis. tanda tangan perangkat tidak sah). */
  extraIntegrity?: { deviceId: string; seq: number; kind: string; at: number; actorId?: string | null }[];
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'CRITICAL';

export interface Incident {
  id: string;
  outletId: string;
  terminalId: string | null;
  orderIds: string[];
  actorIds: string[];
  startAt: number;
  endAt: number;
  hits: RuleHit[];
  modalities: Modality[];
  multiplier: number;
  score: number;
  level: RiskLevel;
}
