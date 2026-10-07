import type { BankTxn, Channel, PosPayment, PosPaymentMethod } from '@pos/domain';

export interface ReconcileOptions {
  /** Toleransi selisih waktu antara pembayaran POS dan transaksi bank. Default 10 menit. */
  windowMs?: number;
  /** Offset zona waktu outlet (menit). Default WIB. */
  utcOffsetMinutes?: number;
  /** Ambang R10 sebagai fraksi (0.005 = 0,5%). */
  r10Threshold?: number;
}

export interface ReconcileInput {
  posPayments: PosPayment[];
  bankTxns: BankTxn[];
  /** TID → batas cakupan laporan (epoch ms). Tanpa entri berarti belum ada laporan untuk TID itu. */
  coverage: Record<string, number>;
  options?: ReconcileOptions;
  /**
   * TID yang terdaftar di registri EDC outlet. Bila diberikan, pembayaran dengan TID di luar daftar ini
   * ditandai R9. Tanpa ini, pemeriksaan registri dilewati.
   */
  knownTids?: string[];
}

export type MatchLevel = 'APPROVAL' | 'TIME' | 'DAY';

export interface Match {
  orderId: string;
  bankIndex: number;
  level: MatchLevel;
}

export type R9Reason = 'TID_UNREGISTERED' | 'APPROVAL_OTHER_TID';

export type Finding =
  /** R7: POS mencatat non-tunai, tidak ada di laporan bank yang sudah mencakup waktunya. */
  | { rule: 'R7'; orderId: string; tid: string; amount: number }
  /** R8: nominal di bank lebih kecil dari nominal di POS. */
  | { rule: 'R8'; orderId: string; tid: string; posAmount: number; bankAmount: number; bankIndex: number }
  /**
   * R9: ketidaksesuaian dengan registri EDC. `TID_UNREGISTERED`: TID yang dipilih kasir tidak ada di registri outlet.
   * `APPROVAL_OTHER_TID`: kode approval, nominal, dan waktu cocok dengan transaksi bank di TID lain
   * (`bankIndex`, `bankTid`). Pasangan ini dianggap cocok, jadi tidak ikut menjadi R7 dan R26.
   */
  | { rule: 'R9'; orderId: string; tid: string; amount: number; reasons: R9Reason[]; bankIndex?: number; bankTid?: string }
  /** Transaksi bank tanpa pembayaran POS (kandidat R26). */
  | { rule: 'R26'; bankIndex: number; tid: string; amount: number; approvalCode: string | null }
  /** Pembayaran terjadi setelah batas cakupan laporan; dievaluasi ulang saat laporan berikutnya. */
  | { rule: 'PENDING_SETTLEMENT'; orderId: string; tid: string; amount: number }
  /** Tidak ada laporan sama sekali untuk TID ini. */
  | { rule: 'NO_BANK_REPORT'; orderId: string; tid: string; amount: number };

export interface DailyTotal {
  tid: string;
  date: string;
  posGross: number;
  bankGross: number;
  /** Bagian selisih (POS − bank) yang sudah dijelaskan oleh temuan R7, R8, R9 (lintas TID), dan R26. */
  explained: number;
  /** Selisih yang tidak dijelaskan temuan lain. */
  residual: number;
  /** R10: selisih yang tidak terjelaskan melebihi ambang. Selisih yang sudah muncul sebagai R7/R8/R26 tidak dihitung dua kali. */
  flagged: boolean;
}

export interface ReconcileResult {
  matches: Match[];
  findings: Finding[];
  r10: DailyTotal[];
}

const DEFAULT_WINDOW_MS = 10 * 60_000;
const DEFAULT_R10 = 0.005;

const CHANNEL_OF: Record<PosPaymentMethod, Channel> = {
  QRIS: 'QRIS',
  EDC_DEBIT: 'CARD_DEBIT',
  EDC_CREDIT: 'CARD_CREDIT',
};

function localDate(ms: number, offsetMinutes: number): string {
  return new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/**
 * Mencocokkan pembayaran non-tunai POS dengan transaksi bank.
 *
 * Urutan tingkat pencocokan (data terbaik yang tersedia dipakai lebih dulu):
 *  1. Kode approval (jika POS menyimpannya)
 *  2. TID + nominal + waktu (±window). Pasangan dipilih dari selisih waktu terkecil secara global,
 *     sehingga dua pembayaran bernominal sama yang berdekatan tidak tertukar.
 *  3. TID + nominal + tanggal, untuk bank yang laporannya tidak mencantumkan jam
 *  4. Nominal bank lebih kecil di TID dan jendela waktu yang sama → R8
 *  5. Kode approval + nominal + waktu cocok di TID lain → R9 (dianggap cocok)
 * Sisa pembayaran POS: pending (di luar cakupan laporan) atau R7. Sisa transaksi bank: R26.
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const windowMs = input.options?.windowMs ?? DEFAULT_WINDOW_MS;
  const offset = input.options?.utcOffsetMinutes ?? 420;
  const r10Threshold = input.options?.r10Threshold ?? DEFAULT_R10;

  const pos = [...input.posPayments].sort((a, b) => a.paidAt - b.paidAt);
  const bank = input.bankTxns;
  const usedPos = new Set<number>();
  const usedBank = new Set<number>();
  const matches: Match[] = [];
  const findings: Finding[] = [];

  const eligible = (bi: number) => bank[bi]!.status === 'SUCCESS' && !usedBank.has(bi);
  const compatible = (p: PosPayment, b: BankTxn) => b.tid === p.tid && b.channel === CHANNEL_OF[p.method];
  const take = (pi: number, bi: number, level: MatchLevel) => {
    usedPos.add(pi);
    usedBank.add(bi);
    matches.push({ orderId: pos[pi]!.orderId, bankIndex: bi, level });
  };

  // Tingkat 1: kode approval
  pos.forEach((p, pi) => {
    if (!p.approvalCode) return;
    const bi = bank.findIndex(
      (b, i) => eligible(i) && compatible(p, b) && b.approvalCode === p.approvalCode,
    );
    if (bi < 0) return;
    take(pi, bi, 'APPROVAL');
    const b = bank[bi]!;
    if (b.amount < p.amount) {
      findings.push({ rule: 'R8', orderId: p.orderId, tid: p.tid, posAmount: p.amount, bankAmount: b.amount, bankIndex: bi });
    }
  });

  // Tingkat 2: nominal sama + waktu terdekat (pasangan global diurutkan dari selisih terkecil)
  const pairs: { pi: number; bi: number; dt: number }[] = [];
  pos.forEach((p, pi) => {
    if (usedPos.has(pi)) return;
    bank.forEach((b, bi) => {
      if (!eligible(bi) || !compatible(p, b) || b.amount !== p.amount || b.txnAt === null) return;
      const dt = Math.abs(b.txnAt - p.paidAt);
      if (dt <= windowMs) pairs.push({ pi, bi, dt });
    });
  });
  pairs.sort((a, b) => a.dt - b.dt || a.pi - b.pi);
  for (const { pi, bi } of pairs) {
    if (!usedPos.has(pi) && !usedBank.has(bi)) take(pi, bi, 'TIME');
  }

  // Tingkat 3: bank tanpa jam → nominal + tanggal, urut kedatangan
  pos.forEach((p, pi) => {
    if (usedPos.has(pi)) return;
    const day = localDate(p.paidAt, offset);
    const bi = bank.findIndex(
      (b, i) => eligible(i) && compatible(p, b) && b.txnAt === null && b.amount === p.amount && b.txnDate === day,
    );
    if (bi >= 0) take(pi, bi, 'DAY');
  });

  // Tingkat 4: nominal bank lebih kecil (R8)
  const lower: { pi: number; bi: number; dt: number }[] = [];
  pos.forEach((p, pi) => {
    if (usedPos.has(pi)) return;
    bank.forEach((b, bi) => {
      if (!eligible(bi) || !compatible(p, b) || b.txnAt === null || b.amount >= p.amount) return;
      const dt = Math.abs(b.txnAt - p.paidAt);
      if (dt <= windowMs) lower.push({ pi, bi, dt });
    });
  });
  lower.sort((a, b) => a.dt - b.dt || a.pi - b.pi);
  for (const { pi, bi } of lower) {
    if (usedPos.has(pi) || usedBank.has(bi)) continue;
    const p = pos[pi]!;
    take(pi, bi, 'TIME');
    findings.push({
      rule: 'R8', orderId: p.orderId, tid: p.tid, posAmount: p.amount, bankAmount: bank[bi]!.amount, bankIndex: bi,
    });
  }

  // R9: TID di luar registri, dan kode approval yang cocok dengan transaksi di TID lain.
  // Pasangan lintas TID memakai nominal dan waktu yang sama (kode approval 6 digit saja bisa kebetulan sama).
  const r9 = new Map<number, { reasons: R9Reason[]; bankIndex?: number }>();
  const flag = (pi: number, reason: R9Reason, bankIndex?: number) => {
    const cur = r9.get(pi) ?? { reasons: [] };
    cur.reasons.push(reason);
    if (bankIndex !== undefined) cur.bankIndex = bankIndex;
    r9.set(pi, cur);
  };
  if (input.knownTids) {
    const known = new Set(input.knownTids);
    pos.forEach((p, pi) => {
      if (!known.has(p.tid)) flag(pi, 'TID_UNREGISTERED');
    });
  }
  pos.forEach((p, pi) => {
    if (usedPos.has(pi) || !p.approvalCode) return;
    const day = localDate(p.paidAt, offset);
    const bi = bank.findIndex(
      (b, i) =>
        eligible(i) && b.approvalCode === p.approvalCode && b.tid !== p.tid && b.amount === p.amount &&
        (b.txnAt !== null ? Math.abs(b.txnAt - p.paidAt) <= windowMs : b.txnDate === day),
    );
    if (bi < 0) return;
    take(pi, bi, 'APPROVAL');
    flag(pi, 'APPROVAL_OTHER_TID', bi);
  });
  for (const [pi, v] of r9) {
    const p = pos[pi]!;
    findings.push({
      rule: 'R9', orderId: p.orderId, tid: p.tid, amount: p.amount, reasons: v.reasons,
      ...(v.bankIndex !== undefined ? { bankIndex: v.bankIndex, bankTid: bank[v.bankIndex]!.tid } : {}),
    });
  }

  // Sisa pembayaran POS
  const excluded = new Set<number>(); // tidak ikut R10 karena belum bisa dinilai
  pos.forEach((p, pi) => {
    if (usedPos.has(pi)) return;
    const end = input.coverage[p.tid];
    if (end === undefined) {
      excluded.add(pi);
      findings.push({ rule: 'NO_BANK_REPORT', orderId: p.orderId, tid: p.tid, amount: p.amount });
    } else if (p.paidAt > end) {
      excluded.add(pi);
      findings.push({ rule: 'PENDING_SETTLEMENT', orderId: p.orderId, tid: p.tid, amount: p.amount });
    } else {
      findings.push({ rule: 'R7', orderId: p.orderId, tid: p.tid, amount: p.amount });
    }
  });

  // Sisa transaksi bank
  bank.forEach((b, bi) => {
    if (b.status !== 'SUCCESS' || usedBank.has(bi)) return;
    findings.push({ rule: 'R26', bankIndex: bi, tid: b.tid, amount: b.amount, approvalCode: b.approvalCode });
  });

  // R10: total bruto per TID per hari (pembayaran pending/tanpa laporan dikeluarkan).
  // Selisih yang sudah dijelaskan R7/R8/R26 dikurangkan, agar masalah yang sama tidak diberi skor dua kali.
  type Bucket = { tid: string; date: string; pos: number; bank: number; explained: number };
  const totals = new Map<string, Bucket>();
  const bucket = (tid: string, date: string): Bucket => {
    const k = `${tid}|${date}`;
    let v = totals.get(k);
    if (!v) totals.set(k, (v = { tid, date, pos: 0, bank: 0, explained: 0 }));
    return v;
  };
  const posByOrder = new Map(pos.map((p) => [p.orderId, p]));
  pos.forEach((p, pi) => {
    if (!excluded.has(pi)) bucket(p.tid, localDate(p.paidAt, offset)).pos += p.amount;
  });
  bank.forEach((b) => {
    if (b.status === 'SUCCESS') bucket(b.tid, b.txnDate).bank += b.amount;
  });
  for (const f of findings) {
    if (f.rule === 'R7') {
      const p = posByOrder.get(f.orderId);
      if (p) bucket(p.tid, localDate(p.paidAt, offset)).explained += f.amount;
    } else if (f.rule === 'R8') {
      const p = posByOrder.get(f.orderId);
      if (p) bucket(p.tid, localDate(p.paidAt, offset)).explained += f.posAmount - f.bankAmount;
    } else if (f.rule === 'R26') {
      const b = bank[f.bankIndex]!;
      bucket(b.tid, b.txnDate).explained -= b.amount;
    } else if (f.rule === 'R9' && f.bankIndex !== undefined) {
      // Seperti R7 di TID pilihan kasir dan R26 di TID bank: kedua selisih itu sudah dijelaskan R9.
      const p = posByOrder.get(f.orderId);
      const b = bank[f.bankIndex]!;
      if (p) bucket(p.tid, localDate(p.paidAt, offset)).explained += p.amount;
      bucket(b.tid, b.txnDate).explained -= b.amount;
    }
  }
  const r10: DailyTotal[] = [...totals.values()]
    .map((v) => {
      const residual = v.pos - v.bank - v.explained;
      return {
        tid: v.tid,
        date: v.date,
        posGross: v.pos,
        bankGross: v.bank,
        explained: v.explained,
        residual,
        flagged: Math.abs(residual) / Math.max(v.pos, v.bank, 1) > r10Threshold,
      };
    })
    .sort((a, b) => a.tid.localeCompare(b.tid) || a.date.localeCompare(b.date));

  return { matches, findings, r10 };
}

export { reconcileSettlement, subsetCandidates } from './settlement';
export type { SettlementFinding, SettlementInput, SettlementResult } from './settlement';
