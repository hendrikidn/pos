import type { Incident, Modality, RiskLevel, RuleHit } from './types';

export const GROUP_WINDOW_MS = 5 * 60_000;

export function multiplier(distinctRules: number, modalities: number): number {
  return Math.min(2, 1 + 0.3 * (distinctRules - 1) + (modalities >= 2 ? 0.4 : 0));
}

export function levelOf(score: number): RiskLevel {
  return score >= 70 ? 'CRITICAL' : score >= 40 ? 'MEDIUM' : 'LOW';
}

interface Group {
  terminalId: string | null;
  orderIds: Set<string>;
  hits: RuleHit[];
  startAt: number;
  endAt: number;
}

const startOf = (h: RuleHit) => Math.min(h.at, h.windowStart);
const span = (hits: RuleHit[]) => {
  const events = hits.filter((h) => !h.context);
  return events.length > 0 ? events : hits;
};
const endOf = (h: RuleHit) => Math.max(h.at, h.windowEnd);

/**
 * Mengelompokkan hit menjadi insiden:
 *  1. Hit kejadian (void, diskon, refund, ...) digabung jika order sama, atau terminal sama dan berdekatan ≤ 5 menit.
 *  2. Hit kondisi (kertas habis, sensor mati) menempel ke setiap insiden di terminal yang sama yang waktunya beririsan,
 *     sehingga satu kertas habis tidak menggabungkan order yang tidak berkaitan. Tanpa insiden untuk ditempeli, ia menjadi insiden sendiri.
 */
export function buildIncidents(hits: RuleHit[]): Incident[] {
  const events = hits.filter((h) => !h.context).sort((a, b) => a.at - b.at);
  const context = hits.filter((h) => h.context);
  const groups: Group[] = [];

  const add = (g: Group, h: RuleHit) => {
    g.hits.push(h);
    if (h.orderId) g.orderIds.add(h.orderId);
    g.startAt = Math.min(g.startAt, startOf(h));
    g.endAt = Math.max(g.endAt, endOf(h));
  };
  const fresh = (h: RuleHit): Group => {
    const g: Group = { terminalId: h.terminalId, orderIds: new Set(), hits: [], startAt: startOf(h), endAt: endOf(h) };
    add(g, h);
    return g;
  };

  for (const h of events) {
    const target = groups.find(
      (g) =>
        (h.orderId !== null && g.orderIds.has(h.orderId)) ||
        (g.terminalId === h.terminalId && h.at - g.endAt <= GROUP_WINDOW_MS && h.at >= g.startAt - GROUP_WINDOW_MS),
    );
    if (target) add(target, h);
    else groups.push(fresh(h));
  }

  for (const h of context) {
    const overlapping = groups.filter(
      (g) =>
        (h.terminalId === null || g.terminalId === null || g.terminalId === h.terminalId) &&
        startOf(h) - GROUP_WINDOW_MS <= g.endAt &&
        endOf(h) + GROUP_WINDOW_MS >= g.startAt,
    );
    if (overlapping.length === 0) groups.push(fresh(h));
    else for (const g of overlapping) g.hits.push(h);
  }

  return groups
    .map((g): Incident => {
      const unique = [...new Map(g.hits.map((h) => [h.key, h])).values()].sort((a, b) => a.at - b.at);
      const rules = new Set(unique.map((h) => h.rule));
      const modalities = [...new Set(unique.flatMap((h) => h.modalities))] as Modality[];
      const m = multiplier(rules.size, modalities.length);
      const sum = unique.reduce((s, h) => s + h.weight, 0);
      const score = Math.round(sum * m);
      return {
        // Stabil terhadap data susulan: berdasarkan hit kejadian paling awal (hit kondisi hanya jika tidak ada yang lain).
        id: `inc:${(unique.find((h) => !h.context) ?? unique[0]!).key}`,
        outletId: unique[0]!.outletId,
        terminalId: g.terminalId,
        orderIds: [...g.orderIds],
        actorIds: [...new Set(unique.flatMap((h) => h.actorIds))],
        // Jendela insiden mengikuti hit kejadian. Hit kondisi (mis. kertas habis berjam-jam) tidak memperlebarnya,
        // karena jendela ini dipakai untuk mencari rekaman CCTV.
        startAt: Math.min(...span(unique).map(startOf)),
        endAt: Math.max(...span(unique).map(endOf)),
        hits: unique,
        modalities,
        multiplier: m,
        score,
        level: levelOf(score),
      };
    })
    .sort((a, b) => a.startAt - b.startAt);
}
