import { Inject, Injectable } from '@nestjs/common';
import type { ApiAuth } from './auth';
import { Database } from './db/database';
import { buildShadowSummary, shadowState, type ShadowState, type ShadowSummary } from './shadow';

export interface ShadowIncidentRow {
  id: string;
  start_ms: number;
  end_ms: number;
  score: number;
  level: 'LOW' | 'MEDIUM' | 'CRITICAL';
  status: string;
  order_ids: string[];
  actor_ids: string[];
  hits: { rule: string }[];
}

export interface ShadowReport {
  state: ShadowState;
  summary: ShadowSummary;
  /** Insiden shadow terbaru (maks. 100). Ringkasan dihitung dari semuanya. */
  incidents: (Omit<ShadowIncidentRow, 'hits'> & { rules: string[] })[];
}

const LIST_LIMIT = 100;

@Injectable()
export class ShadowService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /**
   * "Apa yang akan terdeteksi": insiden yang tercatat selama mode shadow. Seperti daftar insiden biasa, insiden yang
   * melibatkan pengguna itu sendiri tidak ikut dihitung atau ditampilkan.
   */
  async report(auth: ApiAuth, outletId: string, now = Date.now()): Promise<ShadowReport> {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const o = (
        await q.query<{ shadow_days: number; shadow_started_ms: number | null; utc_offset_minutes: number }>(
          'select shadow_days, shadow_started_ms, utc_offset_minutes from outlet where id = $1', [outletId],
        )
      ).rows[0]!;
      const state = shadowState(o.shadow_days, o.shadow_started_ms, now);
      const rows = (
        await q.query<ShadowIncidentRow>(
          `select id, start_ms, end_ms, score, level, status, order_ids, actor_ids, hits from incident
           where outlet_id = $1 and shadow and not jsonb_exists(actor_ids, $2) order by start_ms desc limit 1000`,
          [outletId, auth.userId],
        )
      ).rows;
      return {
        state,
        summary: buildShadowSummary(rows, state, now, o.utc_offset_minutes),
        incidents: rows.filter((r) => r.status !== 'RETRACTED').slice(0, LIST_LIMIT).map(({ hits, ...r }) => ({ ...r, rules: [...new Set(hits.map((h) => h.rule))] })),
      };
    });
  }
}
