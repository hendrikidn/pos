import { correctedTime, type EventOf, type PosEvent } from '@pos/events';
import { DEFAULT_CONFIG, type RuleConfig, type RuleHit } from './types';

/** Hasil hitung ulang kas oleh server untuk satu `cash.counted` (lihat `verifyCashCount` di @pos/order). */
export interface CashCheckInfo {
  deviceId: string;
  seq: number;
  claimed: number;
  serverExpected: number | null;
  status: 'OK' | 'MISMATCH' | 'UNVERIFIABLE';
}

export interface PatternInput {
  /** Event `cash.counted` beberapa hari ke belakang (cukup `r14WindowMs` sebelum hit paling awal yang dilaporkan). */
  events: PosEvent[];
  /**
   * Hit hanya dilaporkan bila kejadiannya sejak waktu ini. Pemanggil mengevaluasi ulang jendela 72 jam,
   * dan insiden lebih lama dari itu tidak ikut dimuat ulang, jadi hit lama akan menggandakan insiden.
   */
  emitFrom: number;
  config?: Partial<RuleConfig>;
  /**
   * Hasil hitung ulang kas oleh server. Bila ada untuk sebuah `cash.counted`, selisihnya dihitung terhadap angka server, bukan
   * `expected` kiriman terminal (yang bisa dipalsukan agar selisihnya selalu nol).
   */
  checks?: CashCheckInfo[];
}

const checkKey = (deviceId: string, seq: number) => `${deviceId}#${seq}`;

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
  const checks = new Map((input.checks ?? []).map((c) => [checkKey(c.deviceId, c.seq), c]));
  const counts = input.events
    .filter((e): e is EventOf<'cash.counted'> => e.type === 'cash.counted' && !!e.actorId)
    .sort((a, b) => correctedTime(a) - correctedTime(b) || a.seq - b.seq);

  const byActor = new Map<string, { e: EventOf<'cash.counted'>; at: number; diff: number }[]>();
  for (const e of counts) {
    const verified = checks.get(checkKey(e.deviceId, e.seq));
    const expected = verified && verified.serverExpected !== null ? verified.serverExpected : e.payload.expected;
    const diff = e.payload.counted - expected;
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

/**
 * R30: `expected` yang dilaporkan terminal berbeda dari hitungan ulang server. Terminal yang jujur dengan pelacakan kas (`tracked`) selalu cocok
 * (aturan hitungnya sama), jadi perbedaan berarti klien dimodifikasi atau event diubah (bobot penuh). Tanpa `tracked` (shift yang melintasi
 * pembaruan aplikasi, atau klien yang menyembunyikannya) tetap dilaporkan tetapi berbobot rendah. Hit dilaporkan hanya untuk kejadian sejak `emitFrom`.
 */
export function evaluateCashMismatch(input: { events: PosEvent[]; checks: CashCheckInfo[]; emitFrom: number; config?: Partial<RuleConfig> }): RuleHit[] {
  const weights = { ...DEFAULT_CONFIG.weights, ...input.config?.weights };
  const byKey = new Map(input.checks.filter((c) => c.status === 'MISMATCH' && c.serverExpected !== null).map((c) => [checkKey(c.deviceId, c.seq), c]));
  const hits: RuleHit[] = [];
  for (const e of input.events) {
    if (e.type !== 'cash.counted') continue;
    const c = byKey.get(checkKey(e.deviceId, e.seq));
    const at = correctedTime(e);
    if (!c || at < input.emitFrom) continue;
    const rp = (n: number) => `Rp${Math.abs(n).toLocaleString('id-ID')}`;
    hits.push({
      rule: 'R30', key: `R30:${e.deviceId}:${e.seq}`, weight: (e.payload.tracked ? weights.R30 : weights.R30_UNTRACKED) ?? 0, modalities: ['POS'], outletId: e.outletId, terminalId: e.deviceId, orderId: null,
      actorIds: e.actorId ? [e.actorId] : [], at, windowStart: at, windowEnd: at, context: false, confidence: 'HIGH',
      note: `terminal melaporkan kas seharusnya ${rp(c.claimed)}, hitungan server ${rp(c.serverExpected!)} (beda ${c.claimed > c.serverExpected! ? 'lebih' : 'kurang'} ${rp(c.claimed - c.serverExpected!)}); hitung fisik ${rp(e.payload.counted)}${e.payload.tracked ? '' : ' (terminal tanpa pelacakan kas: bisa juga karena shift melintasi pembaruan aplikasi, bobot rendah)'}`,
    });
  }
  return hits.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}
