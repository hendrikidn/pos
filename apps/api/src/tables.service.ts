import { Inject, Injectable } from '@nestjs/common';
import { buildTableBoard, TABLE_ORDER_MAX_IDLE_MS, type TableBoard } from '@pos/order';
import type { DeviceAuth } from './auth';
import { Database } from './db/database';
import { EVENT_COLUMNS, rowToEvent, type EventRow } from './guard.service';
import { CLOCK, type Clock } from './pipeline.service';

/** Jenis event yang menentukan apakah satu meja sedang dipakai. */
const TABLE_TYPES = ['order.created', 'order.table_changed', 'order.sent_to_kitchen', 'kitchen.status_changed', 'order.items_moved', 'bill.printed', 'payment.received', 'void.approved'];

@Injectable()
export class TablesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Order dine-in yang masih terbuka di outlet perangkat ini dari semua terminal, dihitung dari event (lihat `buildTableBoard`). */
  async board(device: DeviceAuth): Promise<TableBoard> {
    const now = this.clock();
    // Order yang lebih tua dari batas diam tidak menahan meja; jendela dibuat lebih panjang agar event awal order ikut terbaca.
    const from = now - TABLE_ORDER_MAX_IDLE_MS - 24 * 3_600_000;
    return this.db.tenantTx(device.tenantId, async (q) => {
      const rows = (
        await q.query<EventRow>(
          `select ${EVENT_COLUMNS} from event
           where outlet_id = $1 and type = any($2::text[]) and device_time_ms >= $3 and device_time_ms < $4
           order by device_id, seq`,
          [device.outletId, TABLE_TYPES, from, now + 86_400_000],
        )
      ).rows;
      return buildTableBoard({ events: rows.map(rowToEvent), now });
    });
  }
}
