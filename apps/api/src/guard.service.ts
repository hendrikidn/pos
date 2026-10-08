import { Inject, Injectable } from '@nestjs/common';
import type { PosEvent } from '@pos/events';
import {
  buildIncidents, DEFAULT_CONFIG, evaluateCashMismatch, evaluatePatternRules, evaluateRules, type Capabilities, type Incident, type RuleHit,
} from '@pos/rules';
import { loadCashChecks, verifyPendingCashCounts } from './cash-check';
import { channelHits } from './channel.service';
import { reservationHits } from './reservation-hits';
import { transferHits } from './transfer-hits';
import { Database } from './db/database';
import { shadowState } from './shadow';
import type { Queryable } from './db/driver';

/**
 * Aturan dievaluasi atas event 72 jam terakhir. Aturan pola (Kelas 3, mis. R14) membaca riwayat lebih panjang
 * lewat `evaluatePatternRules`, tetapi hanya melaporkan hit di jendela yang sama agar insiden tidak digandakan.
 */
export const LOOKBACK_MS = 72 * 3_600_000;

export interface EventRow {
  id: string;
  device_id: string;
  outlet_id: string;
  seq: number;
  type: string;
  device_time_ms: number;
  clock_offset_ms: number;
  actor_id: string | null;
  prev_hash: string;
  hash: string;
  payload: Record<string, unknown>;
}

export const EVENT_COLUMNS =
  'id, device_id, outlet_id, seq, type, device_time_ms, clock_offset_ms, actor_id, prev_hash, hash, payload';

export function rowToEvent(r: EventRow): PosEvent {
  return {
    v: 1, id: r.id, deviceId: r.device_id, outletId: r.outlet_id, seq: r.seq, deviceTime: r.device_time_ms,
    clockOffsetMs: r.clock_offset_ms, actorId: r.actor_id, prevHash: r.prev_hash, hash: r.hash,
    type: r.type, payload: r.payload,
  } as PosEvent;
}

export interface EvaluateResult {
  incidents: Incident[];
  /** Insiden kritis yang baru muncul pada evaluasi ini (untuk dikirimi notifikasi). */
  newCritical: Incident[];
}

@Injectable()
export class GuardService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /**
   * Menghitung ulang insiden satu outlet dari event 72 jam terakhir ditambah temuan rekonsiliasi bank,
   * lalu menyimpannya. Status review manusia tidak pernah ditimpa. Insiden terbuka yang tidak lagi
   * dihasilkan (mis. dibatalkan oleh data susulan) ditandai RETRACTED.
   */
  async evaluate(tenantId: string, outletId: string, now = Date.now()): Promise<EvaluateResult> {
    return this.db.tenantTx(tenantId, async (q) => {
      const outlet = (
        await q.query<{ capabilities: Capabilities; terminals: string[]; utc_offset_minutes: number; policy: { employeeMealQuota?: number } | null; shadow_days: number; shadow_started_ms: number | null }>(
          'select capabilities, terminals, utc_offset_minutes, policy, shadow_days, shadow_started_ms from outlet where id = $1',
          [outletId],
        )
      ).rows[0];
      if (!outlet) return { incidents: [], newCritical: [] };

      const from = now - LOOKBACK_MS;
      const events = (
        await q.query<EventRow>(
          `select ${EVENT_COLUMNS} from event where outlet_id = $1 and device_time_ms >= $2 order by device_id, seq`,
          [outletId, from],
        )
      ).rows.map(rowToEvent);

      const extraIntegrity = (
        await q.query<{ device_id: string; seq: number; integrity: string; device_time_ms: number; actor_id: string | null }>(
          `select device_id, seq, integrity, device_time_ms, actor_id from event
           where outlet_id = $1 and device_time_ms >= $2 and integrity in ('BAD_SIGNATURE', 'MISSING_SIGNATURE')`,
          [outletId, from],
        )
      ).rows.map((r) => ({ deviceId: r.device_id, seq: r.seq, kind: r.integrity, at: r.device_time_ms, actorId: r.actor_id }));

      const bankHits = (
        await q.query<{ hit: RuleHit }>('select hit from bank_finding where outlet_id = $1 and at_ms >= $2', [outletId, from])
      ).rows.map((r) => r.hit);

      // Kas yang seharusnya dihitung ulang dari rantai event, tidak dipercaya dari kiriman terminal (R14 dan R30).
      await verifyPendingCashCounts(q, tenantId, outletId, from - DEFAULT_CONFIG.r14WindowMs, now);
      const cashChecks = await loadCashChecks(q, outletId);
      const cashCounts = (
        await q.query<EventRow>(
          `select ${EVENT_COLUMNS} from event where outlet_id = $1 and type = 'cash.counted' and device_time_ms >= $2 order by device_id, seq`,
          [outletId, from - DEFAULT_CONFIG.r14WindowMs],
        )
      ).rows.map(rowToEvent);

      // Promo yang berlaku di outlet ini (termasuk yang sudah dinonaktifkan, karena diskon lama merujuknya).
      const promos = (await q.query<{ id: string; kind: 'PERCENT' | 'AMOUNT'; value: number }>('select id, kind, value from promo where outlet_id is null or outlet_id = $1', [outletId])).rows;

      // Peringatan buku besar poin (saldo kurang, member tidak dikenal/berbeda) menjadi temuan R33.
      const loyaltyHits: RuleHit[] = (
        await q.query<{ device_id: string; seq: number; kind: string; order_id: string; actor_id: string | null; detail: string; at_ms: number }>(
          'select device_id, seq, kind, order_id, actor_id, detail, at_ms from loyalty_alert where outlet_id = $1 and at_ms >= $2', [outletId, from],
        )
      ).rows.map((a) => ({
        rule: 'R33', key: `R33:${a.device_id}:${a.seq}:${a.kind}`, weight: DEFAULT_CONFIG.weights['R33'] ?? 0, modalities: ['POS'], outletId,
        terminalId: a.device_id, orderId: a.order_id, actorIds: a.actor_id ? [a.actor_id] : [], at: Number(a.at_ms), windowStart: Number(a.at_ms), windowEnd: Number(a.at_ms),
        context: false, confidence: 'HIGH' as const, note: a.detail,
      }));

      // Owner dan manager tidak diwajibkan absen (R42).
      const attendanceExempt = (await q.query<{ id: string }>("select id from staff where role in ('OWNER', 'MANAGER')")).rows.map((r) => r.id);

      const hits = [
        ...loyaltyHits,
        ...(await transferHits(q, outletId, now)).filter((t) => t.at >= from).map((t): RuleHit => ({
          rule: t.rule, key: t.key, weight: DEFAULT_CONFIG.weights[t.rule] ?? 0, modalities: ['POS'], outletId, terminalId: null, orderId: null, actorIds: [t.actor],
          at: t.at, windowStart: t.at, windowEnd: t.at, context: false, confidence: 'HIGH', note: t.note,
        })),
        ...(await reservationHits(q, outletId, events, now)).filter((h) => h.at >= from).map((h): RuleHit => ({
          rule: h.rule, key: h.key, weight: DEFAULT_CONFIG.weights[h.rule] ?? 0, modalities: ['POS'], outletId, terminalId: h.terminalId, orderId: h.orderId, actorIds: h.actor ? [h.actor] : [],
          at: h.at, windowStart: h.at, windowEnd: h.at, context: false, confidence: 'HIGH', note: h.note,
        })),
        // Temuan dari data di luar jendela event harus tetap berada di dalam jendela insiden (insiden lama di luar jendela tidak dibaca ulang saat disimpan).
        ...(await channelHits(q, outletId, events, outlet.utc_offset_minutes, from, now)).filter((h) => h.at >= from),
        ...evaluateRules({
          events, now, terminals: outlet.terminals, capabilities: outlet.capabilities, extraIntegrity, promos, attendanceExempt,
          utcOffsetMinutes: outlet.utc_offset_minutes,
          // Kuota makan karyawan diatur owner per outlet, dan sama dengan yang dipakai terminal.
          config: { r6DailyQuota: outlet.policy?.employeeMealQuota ?? DEFAULT_CONFIG.r6DailyQuota },
        }),
        ...evaluatePatternRules({ events: cashCounts, emitFrom: from, checks: cashChecks }),
        ...evaluateCashMismatch({ events: cashCounts, checks: cashChecks, emitFrom: from }),
        ...bankHits,
      ];
      const incidents = buildIncidents(hits).map((i) => ({ ...i, id: `${outletId}:${i.id}` }));
      // Selama mode shadow insiden tetap dihitung dan disimpan, tetapi ditandai dan tidak memicu notifikasi.
      const shadow = shadowState(outlet.shadow_days, outlet.shadow_started_ms, now).active;
      const newCritical = await this.persist(q, tenantId, outletId, incidents, from, shadow);
      return { incidents, newCritical };
    });
  }

  private async persist(
    q: Queryable, tenantId: string, outletId: string, incidents: Incident[], windowStart: number, shadow: boolean,
  ): Promise<Incident[]> {
    const existing = new Map(
      (
        await q.query<{ id: string; status: string; level: string; shadow: boolean }>(
          'select id, status, level, shadow from incident where outlet_id = $1 and start_ms >= $2',
          [outletId, windowStart],
        )
      ).rows.map((r) => [r.id, { status: r.status, level: r.level, shadow: r.shadow }]),
    );
    const newCritical: Incident[] = [];

    for (const i of incidents) {
      const prev = existing.get(i.id);
      const status = prev?.status;
      if (prev === undefined) {
        if (i.level === 'CRITICAL' && !shadow) newCritical.push(i);
        await q.query(
          `insert into incident (id, tenant_id, outlet_id, terminal_id, start_ms, end_ms, score, level, multiplier,
                                 order_ids, actor_ids, hits, shadow)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13)`,
          [
            i.id, tenantId, outletId, i.terminalId, i.startAt, i.endAt, i.score, i.level, i.multiplier,
            JSON.stringify(i.orderIds), JSON.stringify(i.actorIds), JSON.stringify(i.hits), shadow,
          ],
        );
      } else {
        // Hanya insiden OPEN/RETRACTED yang dihitung ulang; yang sudah direview manusia dibiarkan.
        const reopen = status === 'RETRACTED' ? ", status = 'OPEN'" : '';
        if (status === 'OPEN' || status === 'RETRACTED') {
          // Insiden yang naik menjadi kritis karena bukti tambahan juga perlu notifikasi.
          if (i.level === 'CRITICAL' && prev.level !== 'CRITICAL' && !prev.shadow) newCritical.push(i);
          await q.query(
            `update incident set terminal_id = $2, start_ms = $3, end_ms = $4, score = $5, level = $6, multiplier = $7,
                    order_ids = $8::jsonb, actor_ids = $9::jsonb, hits = $10::jsonb, updated_at = now()${reopen}
             where id = $1`,
            [
              i.id, i.terminalId, i.startAt, i.endAt, i.score, i.level, i.multiplier,
              JSON.stringify(i.orderIds), JSON.stringify(i.actorIds), JSON.stringify(i.hits),
            ],
          );
        }
      }
    }

    const live = new Set(incidents.map((i) => i.id));
    for (const [id, { status }] of existing) {
      if (status === 'OPEN' && !live.has(id)) {
        await q.query("update incident set status = 'RETRACTED', updated_at = now() where id = $1", [id]);
      }
    }
    return newCritical;
  }
}
