import { HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { RECEIPT_TOKEN, type PosEvent } from '@pos/events';
import { buildReceipt, type Receipt } from '@pos/order';
import { Database } from './db/database';
import { EVENT_COLUMNS, rowToEvent, type EventRow } from './guard.service';
import { CLOCK, type Clock } from './pipeline.service';
import { RateLimiter } from './rate-limit';

export interface PublicReceipt {
  merchantName: string;
  receipt: Receipt;
}

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;

/**
 * Struk digital publik. Alamatnya hanya token acak 128-bit dari QR; siapa pun yang memegang token boleh membacanya, jadi isinya
 * dibatasi pada yang memang ada di struk kertas (tanpa kasir, TID, atau kode approval). Semua kegagalan menjawab sama (404) dan
 * akses dibatasi per alamat agar token tidak bisa ditebak lewat pencarian massal.
 */
@Injectable()
export class ReceiptService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  async byToken(token: string, caller: string): Promise<PublicReceipt> {
    await this.limiter.enforce(`receipt:${caller}`, MAX_PER_WINDOW, WINDOW_MS, this.clock(), 'terlalu banyak permintaan; coba lagi sebentar');
    if (!RECEIPT_TOKEN.test(token)) throw new NotFoundException('struk tidak ditemukan');
    // Jalur tanpa tenant (publik): koneksi pemilik skema, jadi setiap kueri dibatasi eksplisit oleh outlet hasil pencarian token.
    const ref = (
      await this.db.admin.query<{ outlet_id: string; order_id: string }>(
        "select outlet_id, payload->>'orderId' as order_id from event where type = 'receipt.digital' and payload->>'token' = $1 order by device_id, seq limit 1",
        [token],
      )
    ).rows[0];
    if (!ref) throw new NotFoundException('struk tidak ditemukan');
    const outlet = (await this.db.admin.query<{ merchant_name: string | null; name: string }>('select merchant_name, name from outlet where id = $1', [ref.outlet_id])).rows[0];
    const events: PosEvent[] = (
      await this.db.admin.query<EventRow>(
        `select ${EVENT_COLUMNS} from event
         where outlet_id = $1 and (payload->>'orderId' = $2 or payload->>'originalOrderId' = $2)
           and type in ('order.created', 'order.table_changed', 'bill.printed', 'discount.applied', 'payment.received', 'refund.created', 'void.approved')`,
        [ref.outlet_id, ref.order_id],
      )
    ).rows.map(rowToEvent);
    const receipt = buildReceipt(ref.order_id, events);
    if (!receipt || !outlet) throw new NotFoundException('struk tidak ditemukan');
    return { merchantName: outlet.merchant_name ?? outlet.name, receipt };
  }
}
