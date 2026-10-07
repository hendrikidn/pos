import { correctedTime, type EventOf, type PosEvent } from '@pos/events';
import { DEFAULT_CONFIG, type RuleConfig, type RuleHit } from './types';

export interface PatternInput {
  /** Event `cash.counted` beberapa hari ke belakang (cukup `r14WindowMs` sebelum hit paling awal yang dilaporkan). */
  events: PosEvent[];
  /**
   * Hit hanya dilaporkan bila kejadiannya sejak waktu ini. Pemanggil mengevaluasi ulang jendela 72 jam,
   * dan insiden lebih lama dari itu tidak ikut dimuat ulang, jadi hit lama akan menggandakan insiden.
   */
  emitFrom: number;
  config?: Partial<RuleConfig>;
}

/**
 * Aturan pola (Kelas 3) yang butuh riwayat lebih panjang daripada jendela real-time.
 *
 * R14: selisih blind count di luar toleransi pada lebih dari `r14MaxShifts` shift milik kasir yang sama
 * dalam `r14WindowMs`. Hit diletakkan pada satu titik waktu, yaitu penutupan shift yang melewati batas, bukan
 * membentang di seluruh jendela: jendela insiden dipakai untuk mencari rekaman CCTV, dan jendela lebar akan
 * menyedot hit lain di terminal yang sama ke insiden ini.
 */
export function evaluatePatternRules(input: PatternInput): RuleHit[] {
  const cfg: RuleConfig = {
    ...DEFAULT_CONFIG,
    ...input.config,
    weights: { ...DEFAULT_CONFIG.weights, ...input.config?.weights },
  };
  const counts = input.events
    .filter((e): e is EventOf<'cash.counted'> => e.type === 'cash.counted' && !!e.actorId)
    .sort((a, b) => correctedTime(a) - correctedTime(b) || a.seq - b.seq);

  const byActor = new Map<string, { e: EventOf<'cash.counted'>; at: number; diff: number }[]>();
  for (const e of counts) {
    const diff = e.payload.counted - e.payload.expected;
    if (Math.abs(diff) <= cfg.r14ToleranceAmount) continue;
    const list = byActor.get(e.actorId!) ?? byActor.set(e.actorId!, []).get(e.actorId!)!;
    list.push({ e, at: correctedTime(e), diff });
  }

  const hits: RuleHit[] = [];
  for (const [actor, list] of byActor) {
    list.forEach((cur, i) => {
      if (cur.at < input.emitFrom) return;
      const inWindow = list.slice(0, i + 1).filter((x) => x.at > cur.at - cfg.r14WindowMs);
      if (inWindow.length <= cfg.r14MaxShifts) return;
      hits.push({
        rule: 'R14', key: `R14:${actor}:${cur.e.id}`, weight: cfg.weights.R14 ?? 0, modalities: ['POS'],
        outletId: cur.e.outletId, terminalId: cur.e.deviceId, orderId: null, actorIds: [actor], at: cur.at,
        windowStart: cur.at, windowEnd: cur.at, context: false, confidence: 'HIGH',
        note: `${inWindow.length} shift dalam ${Math.round(cfg.r14WindowMs / 86_400_000)} hari dengan selisih kas di luar Rp${cfg.r14ToleranceAmount.toLocaleString('id-ID')}; ` +
          `terakhir ${cur.diff < 0 ? 'kurang' : 'lebih'} Rp${Math.abs(cur.diff).toLocaleString('id-ID')}`,
      });
    });
  }
  return hits.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}
