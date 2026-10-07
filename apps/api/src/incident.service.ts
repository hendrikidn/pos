import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiAuth } from './auth';
import { Database } from './db/database';
import { shadowState, type ShadowState } from './shadow';

export const REVIEW_LABELS = ['CONFIRMED_FRAUD', 'LEGIT', 'FALSE_ALARM', 'INCONCLUSIVE'] as const;
export type ReviewLabel = (typeof REVIEW_LABELS)[number];

export interface OutletRow {
  id: string;
  name: string;
  cctv_retention_days: number;
  cctv_clock_offset_sec: number;
}

export interface OutletSummary extends OutletRow {
  /** Insiden terbuka yang boleh dilihat pengguna ini (tanpa yang melibatkan dirinya dan tanpa insiden shadow) */
  open_incidents: number;
  open_critical: number;
  /** Status mode shadow, dan jumlah insiden yang tercatat selama shadow (tidak masuk antrean review). */
  shadow: ShadowState & { incidents: number };
}

export interface ReviewRow {
  reviewer: string;
  label: string;
  note: string | null;
  reviewed_at: string;
}

export interface IncidentRow {
  id: string;
  outlet_id: string;
  terminal_id: string | null;
  start_ms: number;
  end_ms: number;
  score: number;
  level: 'LOW' | 'MEDIUM' | 'CRITICAL';
  multiplier: number;
  order_ids: string[];
  actor_ids: string[];
  hits: unknown[];
  status: string;
  /** Tercatat selama mode shadow: tidak dikirim sebagai notifikasi dan tidak masuk antrean review. */
  shadow: boolean;
}

const COLUMNS = 'id, outlet_id, terminal_id, start_ms, end_ms, score, level, multiplier, order_ids, actor_ids, hits, status, shadow';

@Injectable()
export class IncidentService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /**
   * Daftar insiden. Insiden yang melibatkan pengguna itu sendiri (sebagai kasir atau approver) tidak ditampilkan,
   * sehingga manager yang terlibat tidak bisa melihat atau menutup kasusnya sendiri.
   */
  list(auth: ApiAuth, outletId: string, opts: { status?: string; minLevel?: 'LOW' | 'MEDIUM' | 'CRITICAL' } = {}): Promise<IncidentRow[]> {
    const levels = { LOW: ['LOW', 'MEDIUM', 'CRITICAL'], MEDIUM: ['MEDIUM', 'CRITICAL'], CRITICAL: ['CRITICAL'] }[opts.minLevel ?? 'LOW'];
    return this.db.tenantTx(auth.tenantId, async (q) =>
      (
        await q.query<IncidentRow>(
          `select ${COLUMNS} from incident
           where outlet_id = $1 and status = $2 and level = any($3::text[]) and not shadow and not jsonb_exists(actor_ids, $4)
           order by start_ms desc limit 200`,
          [outletId, opts.status ?? 'OPEN', levels, auth.userId],
        )
      ).rows,
    );
  }

  listOutlets(auth: ApiAuth, now = Date.now()): Promise<OutletSummary[]> {
    return this.db.tenantTx(auth.tenantId, async (q) =>
      (
        await q.query<Omit<OutletSummary, 'shadow'> & { shadow_days: number; shadow_started_ms: number | null; shadow_incidents: number }>(
          `select o.id, o.name, o.cctv_retention_days, o.cctv_clock_offset_sec, o.shadow_days, o.shadow_started_ms,
                  (select count(*)::int from incident i
                    where i.outlet_id = o.id and i.status = 'OPEN' and not i.shadow and not jsonb_exists(i.actor_ids, $1)) as open_incidents,
                  (select count(*)::int from incident i
                    where i.outlet_id = o.id and i.status = 'OPEN' and i.level = 'CRITICAL' and not i.shadow and not jsonb_exists(i.actor_ids, $1)) as open_critical,
                  (select count(*)::int from incident i
                    where i.outlet_id = o.id and i.shadow and i.status <> 'RETRACTED' and not jsonb_exists(i.actor_ids, $1)) as shadow_incidents
           from outlet o order by o.name`,
          [auth.userId],
        )
      ).rows.map(({ shadow_days, shadow_started_ms, shadow_incidents, ...o }) => ({
        ...o,
        shadow: { ...shadowState(shadow_days, shadow_started_ms, now), incidents: shadow_incidents },
      })),
    );
  }

  async get(auth: ApiAuth, id: string): Promise<IncidentRow & { reviews: ReviewRow[]; outlet: OutletRow }> {
    const found = await this.db.tenantTx(auth.tenantId, async (q) => {
      const row = (
        await q.query<IncidentRow>(
          `select ${COLUMNS} from incident where id = $1 and not jsonb_exists(actor_ids, $2)`,
          [id, auth.userId],
        )
      ).rows[0];
      if (!row) return undefined;
      const reviews = (
        await q.query<ReviewRow>(
          "select reviewer, label, note, to_char(reviewed_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as reviewed_at from incident_review where incident_id = $1 order by id",
          [id],
        )
      ).rows;
      const outlet = (
        await q.query<OutletRow>('select id, name, cctv_retention_days, cctv_clock_offset_sec from outlet where id = $1', [row.outlet_id])
      ).rows[0]!;
      return { ...row, reviews, outlet };
    });
    if (!found) throw new NotFoundException('insiden tidak ditemukan');
    return found;
  }

  async review(auth: ApiAuth, id: string, label: string, note?: string): Promise<{ status: ReviewLabel }> {
    if (!(REVIEW_LABELS as readonly string[]).includes(label)) {
      throw new BadRequestException(`label harus salah satu dari ${REVIEW_LABELS.join(', ')}`);
    }
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const row = (
        await q.query<{ actor_ids: string[] }>('select actor_ids from incident where id = $1', [id])
      ).rows[0];
      if (!row) throw new NotFoundException('insiden tidak ditemukan');
      if (row.actor_ids.includes(auth.userId)) throw new ForbiddenException('tidak boleh mereview insiden yang melibatkan diri sendiri');
      await q.query('insert into incident_review (tenant_id, incident_id, reviewer, label, note) values ($1, $2, $3, $4, $5)', [
        auth.tenantId, id, auth.userId, label, note ?? null,
      ]);
      await q.query('update incident set status = $2, updated_at = now() where id = $1', [id, label]);
      return { status: label as ReviewLabel };
    });
  }
}
