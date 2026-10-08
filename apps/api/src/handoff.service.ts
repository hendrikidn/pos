import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { buildHandoffs, HANDOFF_CLAIM_TTL_MS, HANDOFF_RESULT_KEEP_MS, type HandoffEntry } from '@pos/order';
import type { DeviceAuth } from './auth';
import { Database } from './db/database';
import { EVENT_COLUMNS, rowToEvent, type EventRow } from './guard.service';
import { CLOCK, type Clock } from './pipeline.service';
import type { Queryable } from './db/driver';

const HANDOFF_TYPES = ['order.handed_off', 'order.handoff_reclaimed', 'order.items_moved'];

/** Order milik terminal lain yang bisa diambil, dalam bentuk yang dipakai terminal (`Handoff` di pos-core). */
export interface IncomingHandoff {
  orderId: string;
  fromDeviceId: string;
  orderType: 'DINE_IN' | 'TAKE_AWAY';
  tableNo?: string;
  items: HandoffEntry['items'];
  at: number;
}

/** Nasib order yang diserahkan terminal ini, supaya terminal asal tahu kapan ordernya sudah diambil. */
export interface OutgoingHandoff {
  orderId: string;
  state: 'PENDING' | 'ACCEPTED' | 'RECLAIMED';
  by?: string;
}

@Injectable()
export class HandoffService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async entries(q: Queryable, outletId: string, now: number): Promise<HandoffEntry[]> {
    const rows = (
      await q.query<EventRow>(
        `select ${EVENT_COLUMNS} from event
         where outlet_id = $1 and type = any($2::text[]) and device_time_ms >= $3 and device_time_ms < $4
         order by device_id, seq`,
        [outletId, HANDOFF_TYPES, now - HANDOFF_RESULT_KEEP_MS - 3_600_000, now + 86_400_000],
      )
    ).rows;
    return buildHandoffs({ events: rows.map(rowToEvent), now });
  }

  /** Order terbuka milik terminal lain (yang belum diklaim terminal lain) dan nasib order yang diserahkan terminal ini. */
  async list(device: DeviceAuth): Promise<{ incoming: IncomingHandoff[]; outgoing: OutgoingHandoff[] }> {
    const now = this.clock();
    return this.db.tenantTx(device.tenantId, async (q) => {
      const entries = await this.entries(q, device.outletId, now);
      const claims = (
        await q.query<{ from_device_id: string; handoff_seq: number; claimed_by: string }>(
          'select from_device_id, handoff_seq, claimed_by from handoff_claim where outlet_id = $1 and claimed_at_ms > $2',
          [device.outletId, now - HANDOFF_CLAIM_TTL_MS],
        )
      ).rows;
      const claimedBy = new Map(claims.map((c) => [`${c.from_device_id}:${c.handoff_seq}`, c.claimed_by]));
      const incoming = entries
        .filter((h) => h.state === 'PENDING' && h.fromDeviceId !== device.deviceId)
        .filter((h) => {
          const by = claimedBy.get(`${h.fromDeviceId}:${h.handoffSeq}`);
          return by === undefined || by === device.deviceId;
        })
        .map(({ orderId, fromDeviceId, orderType, tableNo, items, at }): IncomingHandoff => ({ orderId, fromDeviceId, orderType, ...(tableNo ? { tableNo } : {}), items, at }));
      const outgoing = entries
        .filter((h) => h.fromDeviceId === device.deviceId)
        .map((h): OutgoingHandoff => ({ orderId: h.orderId, state: h.state, ...(h.by ? { by: h.by } : {}) }));
      return { incoming, outgoing };
    });
  }

  /**
   * Klaim atomik atas order yang diserahkan: terminal lain, atau terminal asalnya sendiri untuk menariknya kembali. Pemenangnya ditentukan
   * kunci unik di database; yang kalah mendapat 409. Klaim ulang oleh pemenang yang sama aman (mengulang pengambilan yang terputus), dan
   * klaim yang tidak diselesaikan dilepas setelah `HANDOFF_CLAIM_TTL_MS`.
   */
  async claim(device: DeviceAuth, orderId: string): Promise<IncomingHandoff> {
    const now = this.clock();
    return this.db.tenantTx(device.tenantId, async (q) => {
      const matches = (await this.entries(q, device.outletId, now)).filter((h) => h.orderId === orderId);
      const entry = matches[matches.length - 1];
      if (!entry) throw new NotFoundException('order ini belum tercatat sebagai diserahkan (mungkin belum sampai ke server; coba lagi sebentar)');
      if (entry.state === 'ACCEPTED') throw new ConflictException('order ini sudah diambil terminal lain');
      if (entry.state === 'RECLAIMED') throw new ConflictException('order ini sudah ditarik kembali oleh terminal asalnya');
      const won = await q.query(
        `insert into handoff_claim (tenant_id, outlet_id, from_device_id, handoff_seq, order_id, claimed_by, claimed_at_ms)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (outlet_id, from_device_id, handoff_seq) do update
           set claimed_by = excluded.claimed_by, claimed_at_ms = excluded.claimed_at_ms
           where handoff_claim.claimed_by = excluded.claimed_by or handoff_claim.claimed_at_ms <= $8
         returning claimed_by`,
        [device.tenantId, device.outletId, entry.fromDeviceId, entry.handoffSeq, orderId, device.deviceId, now, now - HANDOFF_CLAIM_TTL_MS],
      );
      if (won.rowCount === 0) throw new ConflictException('order ini sedang diambil terminal lain');
      const { orderType, tableNo, items, at, fromDeviceId } = entry;
      return { orderId, fromDeviceId, orderType, ...(tableNo ? { tableNo } : {}), items, at };
    });
  }
}
