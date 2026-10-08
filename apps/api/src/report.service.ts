import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ApiAuth } from './auth';
import { Database } from './db/database';
import { loadCashChecks, verifyPendingCashCounts } from './cash-check';
import { EVENT_COLUMNS, rowToEvent, type EventRow } from './guard.service';
import { addDays, buildSalesReport, compareSales, DAY_MS, localDate, startOfLocalDay, type Comparison, type SalesReport } from './sales-report';
import type { Queryable } from './db/driver';

export const MAX_REPORT_DAYS = 31;
const DEFAULT_DAYS = 7;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const RANGES = ['today', 'yesterday', '7d', '30d', 'month'] as const;
export type RangePreset = (typeof RANGES)[number];

function presetRange(r: RangePreset, today: string): { from: string; to: string } {
  switch (r) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: addDays(today, -1), to: addDays(today, -1) };
    case '7d': return { from: addDays(today, -6), to: today };
    case '30d': return { from: addDays(today, -29), to: today };
    case 'month': return { from: `${today.slice(0, 8)}01`, to: today };
  }
}

const validDate = (s: string): boolean => DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

@Injectable()
export class ReportService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /**
   * Laporan penjualan satu outlet untuk rentang tanggal lokal outlet (inklusif). Rentang bisa berupa `from`/`to`
   * atau preset `range` yang dihitung dengan zona waktu outlet (today, yesterday, 7d, 30d, month = awal bulan sampai
   * hari ini). Tanpa parameter: 7 hari terakhir. Rentang dibatasi 31 hari agar jumlah event yang dibaca tetap kecil.
   */
  async sales(
    auth: ApiAuth, outletId: string, params: { from?: string; to?: string; range?: string; compare?: string }, now = Date.now(),
  ): Promise<SalesReport & { comparison?: Comparison }> {
    if (params.compare !== undefined && params.compare !== '1' && params.compare !== 'prev') throw new BadRequestException('compare harus 1 atau prev');
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const outlet = (await q.query<{ utc_offset_minutes: number }>('select utc_offset_minutes from outlet where id = $1', [outletId])).rows[0];
      if (!outlet) throw new BadRequestException('outlet tidak ditemukan');
      const off = outlet.utc_offset_minutes;

      const today = localDate(now, off);
      let { from, to } = params;
      if (params.range !== undefined) {
        if (from !== undefined || to !== undefined) throw new BadRequestException('pakai range atau from/to, tidak keduanya');
        if (!(RANGES as readonly string[]).includes(params.range)) throw new BadRequestException(`range harus salah satu dari ${RANGES.join(', ')}`);
        ({ from, to } = presetRange(params.range as RangePreset, today));
      }
      to = to ?? today;
      from = from ?? addDays(to, -(DEFAULT_DAYS - 1));
      if (!validDate(from) || !validDate(to)) throw new BadRequestException('tanggal harus berformat YYYY-MM-DD');
      if (from > to) throw new BadRequestException('tanggal awal tidak boleh setelah tanggal akhir');
      if (to > today) throw new BadRequestException('tanggal akhir tidak boleh di masa depan');
      const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
      if (days > MAX_REPORT_DAYS) throw new BadRequestException(`rentang maksimal ${MAX_REPORT_DAYS} hari`);

      const report = await this.compute(q, auth, outletId, from, to, off, now);
      if (params.compare === undefined) return report;
      // Periode sebelumnya: sama panjang, tepat sebelum periode ini.
      const prev = await this.compute(q, auth, outletId, addDays(from, -days), addDays(from, -1), off, now);
      return { ...report, comparison: compareSales(report, prev, today) };
    });
  }

  /** Laporan satu rentang tanggal lokal yang sudah divalidasi. */
  private async compute(q: Queryable, auth: ApiAuth, outletId: string, from: string, to: string, off: number, now: number): Promise<SalesReport> {
    const fromMs = startOfLocalDay(from, off);
    const toMs = startOfLocalDay(to, off) + DAY_MS;

    // Jendela dilebarkan: jam perangkat bisa bergeser, dan order bisa dibuat sehari sebelum dibayar.
    const rows = (
      await q.query<EventRow>(
        `select ${EVENT_COLUMNS} from event
         where outlet_id = $1 and device_time_ms >= $2 and device_time_ms < $3
           and type in ('payment.received', 'refund.created', 'discount.applied', 'cash.counted', 'order.created', 'bill.printed', 'bill.hold_reason')
         order by device_id, seq`,
        [outletId, fromMs - 2 * DAY_MS, toMs + DAY_MS],
      )
    ).rows;
    // Void bisa terjadi lama setelah pembayaran, jadi dibaca sampai sekarang agar order yang sudah di-void tidak terhitung.
    const voids = (
      await q.query<EventRow>(
        `select ${EVENT_COLUMNS} from event
         where outlet_id = $1 and type = 'void.approved' and device_time_ms >= $2 and device_time_ms < $3
         order by device_id, seq`,
        [outletId, fromMs - DAY_MS, Math.max(toMs, now) + DAY_MS],
      )
    ).rows;

    // Hitung ulang kas yang belum diperiksa agar laporan selalu memakai angka server (idempoten).
    await verifyPendingCashCounts(q, auth.tenantId, outletId, fromMs - 2 * DAY_MS, now);
    return buildSalesReport({
      events: [...rows, ...voids].map(rowToEvent), fromMs, toMs, from, to, utcOffsetMinutes: off, now, cashChecks: await loadCashChecks(q, outletId),
    });
  }
}
