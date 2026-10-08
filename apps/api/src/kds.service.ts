import { Inject, Injectable } from '@nestjs/common';
import { buildKitchenBoard, KDS_HISTORY_MS, KDS_VOID_VISIBLE_MS, type KdsBoard } from '@pos/order';
import type { DeviceAuth } from './auth';
import { Database } from './db/database';
import { EVENT_COLUMNS, rowToEvent, type EventRow } from './guard.service';
import { CLOCK, type Clock } from './pipeline.service';

/** Jenis event yang membentuk tiket dapur. */
const BOARD_TYPES = ['order.created', 'order.table_changed', 'order.sent_to_kitchen', 'kitchen.status_changed', 'order.items_moved', 'void.approved'];

@Injectable()
export class KdsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Papan tiket dapur outlet perangkat ini, dihitung dari event (lihat `buildKitchenBoard`). */
  async board(device: DeviceAuth): Promise<KdsBoard> {
    const now = this.clock();
    const from = now - KDS_HISTORY_MS - KDS_VOID_VISIBLE_MS - 2 * 3_600_000;
    return this.db.tenantTx(device.tenantId, async (q) => {
      const rows = (
        await q.query<EventRow>(
          `select ${EVENT_COLUMNS} from event
           where outlet_id = $1 and type = any($2::text[]) and device_time_ms >= $3 and device_time_ms < $4
           order by device_id, seq`,
          [device.outletId, BOARD_TYPES, from, now + 86_400_000],
        )
      ).rows;
      return buildKitchenBoard({ events: rows.map(rowToEvent), now });
    });
  }
}
