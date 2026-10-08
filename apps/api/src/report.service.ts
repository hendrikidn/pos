import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ApiAuth } from './auth';
import { Database } from './db/database';
import { loadCashChecks, verifyPendingCashCounts } from './cash-check';
import { EVENT_COLUMNS, rowToEvent, type EventRow } from './guard.service';
import { buildExport, EXPORT_EVENT_TYPES, EXPORT_KINDS, toCsv, type ExportKind } from './sales-export';
import { resolveRange } from './report-range';
import { addDays, buildSalesReport, compareSales, DAY_MS, startOfLocalDay, type Comparison, type SalesReport } from './sales-report';
import type { Queryable } from './db/driver';

export { MAX_REPORT_DAYS, RANGES, type RangePreset } from './report-range';

@Injectable()
export class ReportService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /**
   * Ekspor CSV penjualan satu outlet (lihat `sales-export.ts`) untuk rentang yang sama dengan laporan: `from`/`to` atau `range`, maks. 31 hari.
   * Mengembalikan isi CSV dan nama berkas yang menyebut outlet, jenis, dan rentang.
   */
  async export(auth: ApiAuth, outletId: string, kind: string, params: { from?: string; to?: string; range?: string }, now = Date.now()): Promise<{ filename: string; csv: string }> {
    if (!(EXPORT_KINDS as readonly string[]).includes(kind)) throw new BadRequestException(`jenis ekspor harus salah satu dari ${EXPORT_KINDS.join(', ')}`);
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const outlet = (await q.query<{ utc_offset_minutes: number }>('select utc_offset_minutes from outlet where id = $1', [outletId])).rows[0];
      if (!outlet) throw new BadRequestException('outlet tidak ditemukan');
      const off = outlet.utc_offset_minutes;
      const { from, to } = this.resolveRange(off, params, now);
      const fromMs = startOfLocalDay(from, off);
      const toMs = startOfLocalDay(to, off) + DAY_MS;
      const rows = (
        await q.query<EventRow>(
          `select ${EVENT_COLUMNS} from event
           where outlet_id = $1 and device_time_ms >= $2 and device_time_ms < $3 and type = any($4::text[])
           order by device_id, seq`,
          [outletId, fromMs - 2 * DAY_MS, toMs + DAY_MS, EXPORT_EVENT_TYPES],
        )
      ).rows;
      const voids = (
        await q.query<EventRow>(
          `select ${EVENT_COLUMNS} from event
           where outlet_id = $1 and type = 'void.approved' and device_time_ms >= $2 and device_time_ms < $3 order by device_id, seq`,
          [outletId, fromMs - DAY_MS, Math.max(toMs, now) + DAY_MS],
        )
      ).rows;
      const table = buildExport(kind as ExportKind, { events: [...rows, ...voids].map(rowToEvent), from, to, utcOffsetMinutes: off, now, fromMs, toMs });
      await q.query("insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, 'export.sales', $3::jsonb)", [auth.tenantId, auth.userId, JSON.stringify({ outletId, kind, from, to, rows: table.rows.length })]);
      return { filename: `${outletId}-${table.slug}-${from}_${to}.csv`, csv: toCsv(table) };
    });
  }

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

      const { from, to, days, today } = this.resolveRange(off, params, now);

      const report = await this.compute(q, auth, outletId, from, to, off, now);
      if (params.compare === undefined) return report;
      // Periode sebelumnya: sama panjang, tepat sebelum periode ini.
      const prev = await this.compute(q, auth, outletId, addDays(from, -days), addDays(from, -1), off, now);
      return { ...report, comparison: compareSales(report, prev, today) };
    });
  }


  private resolveRange(off: number, params: { from?: string; to?: string; range?: string }, now: number) {
    return resolveRange(off, params, now);
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
