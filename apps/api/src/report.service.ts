import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ApiAuth } from './auth';
import { Database } from './db/database';
import { loadCashChecks, verifyPendingCashCounts } from './cash-check';
import { EVENT_COLUMNS, rowToEvent, type EventRow } from './guard.service';
import { buildExport, EXPORT_EVENT_TYPES, EXPORT_KINDS, toCsv, type ExportKind } from './sales-export';
import { resolveRange } from './report-range';
import { buildTaxReport, MONTH_RE, taxReportCsv, type TaxReport } from './tax-report';
import { addDays, buildSalesReport, compareSales, DAY_MS, localDate, startOfLocalDay, type Comparison, type SalesReport } from './sales-report';
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
   * Laporan pajak bulanan (`month` = YYYY-MM, bulan berjalan dan yang sudah lewat). Mengembalikan struktur laporan dan CSV-nya; pembacaan tercatat di audit.
   */
  async taxReport(auth: ApiAuth, outletId: string, month: unknown, now = Date.now()): Promise<{ report: TaxReport; csv: string; filename: string }> {
    if (typeof month !== 'string' || !MONTH_RE.test(month)) throw new BadRequestException('month harus berformat YYYY-MM');
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const report = await this.taxMonth(q, outletId, month, now);
      await q.query("insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, 'export.tax', $3::jsonb)", [auth.tenantId, auth.userId, JSON.stringify({ outletId, month })]);
      return { report, csv: taxReportCsv(report), filename: `${outletId}-pajak-${month}.csv` };
    });
  }

  /** Satu bulan laporan pajak satu outlet (tanpa audit); dipakai laporan bulanan dan ringkasan tahunan. */
  private async taxMonth(q: Queryable, outletId: string, month: string, now: number): Promise<TaxReport> {
    const o = (await q.query<{ name: string; merchant_name: string | null; utc_offset_minutes: number; tax_percent: number; service_charge_percent: number; tax_on_service: boolean }>(
      'select name, merchant_name, utc_offset_minutes, tax_percent, service_charge_percent, tax_on_service from outlet where id = $1', [outletId],
    )).rows[0];
    if (!o) throw new BadRequestException('outlet tidak ditemukan');
    const off = o.utc_offset_minutes;
    const today = localDate(now, off);
    const from = `${month}-01`;
    if (from > today) throw new BadRequestException('bulan tidak boleh di masa depan');
    const next = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1);
    const last = new Date(next - DAY_MS).toISOString().slice(0, 10);
    const to = last > today ? today : last;
    const fromMs = startOfLocalDay(from, off);
    const toMs = startOfLocalDay(to, off) + DAY_MS;
    const rows = (await q.query<EventRow>(
      `select ${EVENT_COLUMNS} from event
       where outlet_id = $1 and device_time_ms >= $2 and device_time_ms < $3 and type = any($4::text[]) order by device_id, seq`,
      [outletId, fromMs - 2 * DAY_MS, toMs + DAY_MS, EXPORT_EVENT_TYPES],
    )).rows;
    const voids = (await q.query<EventRow>(
      `select ${EVENT_COLUMNS} from event where outlet_id = $1 and type = 'void.approved' and device_time_ms >= $2 and device_time_ms < $3 order by device_id, seq`,
      [outletId, fromMs - DAY_MS, Math.max(toMs, now) + DAY_MS],
    )).rows;
    return buildTaxReport(
      { events: [...rows, ...voids].map(rowToEvent), from, to, utcOffsetMinutes: off, now, fromMs, toMs },
      { name: o.merchant_name ?? o.name, taxPercent: o.tax_percent, servicePercent: o.service_charge_percent, taxOnService: o.tax_on_service }, month,
    );
  }

  /**
   * Ringkasan pajak setahun: per bulan omzet, dasar pengenaan, PBJT yang dipungut, dan (bila profil pemberi kerja menyalakan UMKM final) PPh Final 0,5% atas omzet.
   * `outletId` = `all` menjumlahkan semua outlet (OWNER): batas bebas Rp500 juta wajib pajak orang pribadi berlaku atas omzet SELURUH usaha, bukan per outlet.
   * Bahan SPT dan setoran, bukan SPT.
   */
  async annualTax(auth: ApiAuth, outletId: string, yearRaw: unknown, now = Date.now()) {
    const y = typeof yearRaw === 'string' && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : NaN;
    if (!Number.isInteger(y) || y < 2024 || y > new Date(now).getUTCFullYear()) throw new BadRequestException('year harus tahun 2024 sampai tahun berjalan (YYYY)');
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const outlets = outletId === 'all'
        ? (await q.query<{ id: string }>('select id from outlet order by id')).rows.map((r) => r.id)
        : (await q.query<{ id: string }>('select id from outlet where id = $1', [outletId])).rows.map((r) => r.id);
      if (outlets.length === 0) throw new BadRequestException('outlet tidak ditemukan');
      const profile = (await q.query<{ umkm_final: boolean; taxpayer_type: 'OP' | 'BADAN' }>('select umkm_final, taxpayer_type from employer_tax_profile limit 1')).rows[0];
      const todayMonth = new Date(now + 7 * 3_600_000).toISOString().slice(0, 7);
      const months: { month: string; orders: number; omzet: number; taxBase: number; pbjt: number; service: number; withoutBreakdown: number }[] = [];
      for (let m = 1; m <= 12; m++) {
        const ym = `${y}-${String(m).padStart(2, '0')}`;
        if (ym > todayMonth) break;
        const acc = { month: ym, orders: 0, omzet: 0, taxBase: 0, pbjt: 0, service: 0, withoutBreakdown: 0 };
        for (const id of outlets) {
          const r = await this.taxMonth(q, id, ym, now);
          acc.orders += r.totals.orders; acc.omzet += r.totals.omzet; acc.taxBase += r.totals.taxBase; acc.pbjt += r.totals.tax; acc.service += r.totals.service; acc.withoutBreakdown += r.withoutBreakdown;
        }
        months.push(acc);
      }
      const FINAL_RATE = 0.005;
      const EXEMPT = 500_000_000;
      let cum = 0;
      let prevFinal = 0;
      const rows = months.map((m) => {
        cum += m.omzet;
        const finalCum = profile?.umkm_final ? Math.floor(FINAL_RATE * Math.max(0, cum - (profile.taxpayer_type === 'OP' ? EXEMPT : 0))) : 0;
        const monthlyFinal = finalCum - prevFinal;
        prevFinal = finalCum;
        return { ...m, cumulativeOmzet: cum, pphFinal: monthlyFinal };
      });
      await q.query("insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, 'report.annual_tax', $3::jsonb)", [auth.tenantId, auth.userId, JSON.stringify({ outletId, year: y })]);
      return {
        year: y, outletId, months: rows, umkmFinal: profile?.umkm_final ?? false, taxpayerType: profile?.taxpayer_type ?? null,
        totals: { omzet: cum, pbjt: rows.reduce((s, r) => s + r.pbjt, 0), pphFinal: prevFinal },
        notes: [
          'PBJT adalah pajak daerah; tarif dan tata cara setor mengikuti peraturan daerah.',
          profile?.umkm_final
            ? `PPh Final UMKM ${(FINAL_RATE * 100).toFixed(1)}% (PP 55/2022) dihitung atas omzet kumulatif${profile.taxpayer_type === 'OP' ? ', dengan Rp500 juta pertama setahun tidak dikenai (wajib pajak orang pribadi)' : ''}. Syarat (omzet maksimal Rp4,8 miliar setahun dan jangka waktu pemanfaatan) dan batas waktu setor/lapor tidak diperiksa di sini: konfirmasi ke konsultan pajak.`
            : 'PPh Final UMKM belum dinyalakan di profil pemberi kerja (Pajak & BPJS di SDM).',
          'Ini bahan SPT dan setoran, bukan SPT. Laba rugi dan neraca untuk SPT Tahunan ada di Akuntansi > Laporan keuangan.',
        ],
      };
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
