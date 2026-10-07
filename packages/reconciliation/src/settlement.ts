import type { Channel, PosPayment, PosPaymentMethod, SettlementLine, SettlementSummary } from '@pos/domain';

const CHANNEL_OF: Record<PosPaymentMethod, Channel> = {
  QRIS: 'QRIS',
  EDC_DEBIT: 'CARD_DEBIT',
  EDC_CREDIT: 'CARD_CREDIT',
};

export interface SettlementInput {
  summary: SettlementSummary;
  posPayments: PosPayment[];
  /**
   * Batas awal batch (waktu penutupan batch sebelumnya pada TID yang sama). Bila null, dianggap awal hari
   * penutupan (kasir menutup batch tiap hari) dan hasilnya diberi catatan WINDOW_ASSUMED.
   */
  windowStartMs: number | null;
  utcOffsetMinutes?: number;
}

export type SettlementFinding =
  /** R27: jumlah/total POS berbeda dengan slip pada satu jenis pembayaran. `candidates` adalah himpunan order POS yang selisihnya pas. */
  | {
      rule: 'R27';
      channel: Channel;
      pos: SettlementLine;
      slip: SettlementLine;
      diffCount: number;
      diffAmount: number;
      candidates: string[][];
    }
  /** R28: selisih satu jenis diimbangi tepat oleh jenis lain; kemungkinan salah memilih metode bayar di POS. */
  | { rule: 'R28'; recordedAs: Channel; settledAs: Channel; count: number; amount: number; candidates: string[][] }
  /** Slip memuat void/refund, sehingga pembanding bisa sale atau sale−void−refund. */
  | { rule: 'SLIP_HAS_VOID_REFUND'; channel: Channel; void: SettlementLine; refund: SettlementLine }
  | { rule: 'WINDOW_ASSUMED'; fromMs: number };

export interface SettlementResult {
  findings: SettlementFinding[];
  /** Perbandingan per jenis pembayaran, termasuk yang cocok. */
  channels: { channel: Channel; pos: SettlementLine; slip: SettlementLine; ok: boolean }[];
}

const MAX_SUBSET_SIZE = 3;
const MAX_CANDIDATES = 5;
const MAX_STEPS = 200_000;

/** Himpunan order (ukuran ≤ 3) yang jumlahnya tepat `target`. Dibatasi agar tidak meledak pada batch besar. */
export function subsetCandidates(payments: PosPayment[], size: number, target: number): string[][] {
  if (size < 1 || size > MAX_SUBSET_SIZE || target <= 0) return [];
  const out: string[][] = [];
  let steps = 0;
  const walk = (start: number, left: number, sum: number, picked: string[]): void => {
    if (out.length >= MAX_CANDIDATES || steps++ > MAX_STEPS) return;
    if (left === 0) {
      if (sum === target) out.push([...picked]);
      return;
    }
    for (let i = start; i < payments.length; i++) {
      const p = payments[i]!;
      if (sum + p.amount > target) continue;
      picked.push(p.orderId);
      walk(i + 1, left - 1, sum + p.amount, picked);
      picked.pop();
    }
  };
  walk(0, size, 0, []);
  return out;
}

const tally = (list: PosPayment[]): SettlementLine => ({ count: list.length, amount: list.reduce((s, p) => s + p.amount, 0) });

/**
 * Rekonsiliasi per batch: membandingkan jumlah dan total pembayaran non-tunai POS dengan slip settlement.
 * Tanpa rincian per transaksi, yang bisa dikatakan hanya "selisih berapa dan kemungkinan order mana".
 */
export function reconcileSettlement(input: SettlementInput): SettlementResult {
  const { summary } = input;
  const offset = input.utcOffsetMinutes ?? 420;
  const findings: SettlementFinding[] = [];

  let from = input.windowStartMs;
  if (from === null) {
    const local = new Date(summary.closedAt + offset * 60_000);
    from = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset * 60_000;
    findings.push({ rule: 'WINDOW_ASSUMED', fromMs: from });
  }

  const byChannel = new Map<Channel, PosPayment[]>();
  for (const p of input.posPayments) {
    if (p.tid !== summary.tid || p.paidAt <= from || p.paidAt > summary.closedAt) continue;
    const c = CHANNEL_OF[p.method];
    byChannel.set(c, [...(byChannel.get(c) ?? []), p]);
  }

  const channels = new Set<Channel>([...byChannel.keys(), ...(Object.keys(summary.channels) as Channel[])]);
  const rows: SettlementResult['channels'] = [];
  const diffs: { channel: Channel; dCount: number; dAmount: number; slip: SettlementLine; pos: SettlementLine }[] = [];

  for (const channel of channels) {
    const pos = tally(byChannel.get(channel) ?? []);
    const s = summary.channels[channel];
    let slip = s?.sale ?? { count: 0, amount: 0 };

    if (s && (s.void.count > 0 || s.refund.count > 0)) {
      findings.push({ rule: 'SLIP_HAS_VOID_REFUND', channel, void: s.void, refund: s.refund });
      // Belum diketahui apakah SALE sudah dikurangi void/refund; pakai pembanding yang selisihnya lebih kecil.
      const net = { count: s.sale.count - s.void.count - s.refund.count, amount: s.sale.amount - s.void.amount - s.refund.amount };
      if (Math.abs(pos.amount - net.amount) < Math.abs(pos.amount - slip.amount)) slip = net;
    }

    const dCount = pos.count - slip.count;
    const dAmount = pos.amount - slip.amount;
    rows.push({ channel, pos, slip, ok: dCount === 0 && dAmount === 0 });
    if (dCount !== 0 || dAmount !== 0) diffs.push({ channel, dCount, dAmount, slip, pos });
  }

  // R28: selisih positif pada satu jenis diimbangi tepat oleh selisih negatif pada jenis lain.
  const remaining = [...diffs];
  for (const plus of diffs.filter((d) => d.dCount > 0 && d.dAmount > 0)) {
    const j = remaining.findIndex((m) => m.dCount === -plus.dCount && m.dAmount === -plus.dAmount);
    if (j < 0 || !remaining.includes(plus)) continue;
    const minus = remaining[j]!;
    findings.push({
      rule: 'R28', recordedAs: plus.channel, settledAs: minus.channel, count: plus.dCount, amount: plus.dAmount,
      candidates: subsetCandidates(byChannel.get(plus.channel) ?? [], plus.dCount, plus.dAmount),
    });
    remaining.splice(j, 1);
    remaining.splice(remaining.indexOf(plus), 1);
  }

  for (const d of remaining) {
    findings.push({
      rule: 'R27', channel: d.channel, pos: d.pos, slip: d.slip, diffCount: d.dCount, diffAmount: d.dAmount,
      candidates: d.dCount > 0 && d.dAmount > 0 ? subsetCandidates(byChannel.get(d.channel) ?? [], d.dCount, d.dAmount) : [],
    });
  }

  return { findings, channels: rows };
}
