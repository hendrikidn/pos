import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ONLINE_CHANNELS, type OnlineChannel } from '@pos/events';
import type { RuleHit } from '@pos/rules';
import type { ApiAuth } from './auth';
import { findingToHit, parseChannelReport, posOnlineOrders, reconcileChannel, type PlatformRow } from './channel-report';
import { Database } from './db/database';
import type { Queryable } from './db/driver';
import { EVENT_COLUMNS, rowToEvent, type EventRow } from './guard.service';
import { resolveRange } from './report-range';
import { DAY_MS, localDate, startOfLocalDay } from './sales-report';

const EVENT_TYPES = ['order.channel_linked', 'void.approved', 'bill.printed', 'payment.received'];

export interface ChannelImportResult {
  applied: boolean;
  errors: { line: number; message: string }[];
  rows: number;
  inserted: number;
  updated: number;
  dateFrom: string | null;
  dateTo: string | null;
}

interface OrderRow { channel: OnlineChannel; ref: string; date: string; gross: number; commission: number; net: number }

/**
 * Temuan rekonsiliasi pesanan online untuk satu outlet (dipakai GuardService): membandingkan order online di POS pada jendela evaluasi dengan
 * baris laporan platform yang sudah diunggah. Tanpa laporan = tidak ada temuan.
 */
export async function channelHits(q: Queryable, outletId: string, events: Parameters<typeof posOnlineOrders>[0], offsetMinutes: number, windowStart: number, now: number): Promise<RuleHit[]> {
  const fromDate = localDate(windowStart, offsetMinutes);
  const rows = (await q.query<OrderRow & { line: number }>('select channel, ref, date, gross, commission, net from channel_order where outlet_id = $1 and date >= $2', [outletId, fromDate])).rows;
  if (rows.length === 0) return [];
  const findings = reconcileChannel({
    orders: posOnlineOrders(events, offsetMinutes),
    rows: rows.map((r, i) => ({ channel: r.channel, row: { line: i, ref: r.ref, date: r.date, gross: r.gross, commission: r.commission, net: r.net } as PlatformRow })),
    fromDate, nowMs: now,
  });
  return findings.map((f) => findingToHit(f, outletId));
}

@Injectable()
export class ChannelService {
  constructor(@Inject(Database) private readonly db: Database) {}

  private async outlet(q: Queryable, outletId: string) {
    const o = (await q.query<{ utc_offset_minutes: number; online_channels: { channel: string }[] }>('select utc_offset_minutes, online_channels from outlet where id = $1', [outletId])).rows[0];
    if (!o) throw new NotFoundException('outlet tidak ditemukan');
    return o;
  }

  /** Mengunggah laporan platform: baris yang nomor pesanannya sudah ada diperbarui (laporan susulan boleh menimpa). Semua atau tidak sama sekali. */
  async importReport(auth: ApiAuth, outletId: string, input: { channel?: unknown; csv?: unknown; filename?: unknown }): Promise<ChannelImportResult> {
    if (typeof input.channel !== 'string' || !(ONLINE_CHANNELS as readonly string[]).includes(input.channel)) throw new BadRequestException(`kanal harus salah satu dari ${ONLINE_CHANNELS.join(', ')}`);
    if (typeof input.csv !== 'string') throw new BadRequestException('csv wajib berupa teks');
    const channel = input.channel as OnlineChannel;
    const parsed = parseChannelReport(input.csv);
    const empty = { rows: 0, inserted: 0, updated: 0, dateFrom: null, dateTo: null };
    if (parsed.errors.length > 0) return { applied: false, errors: parsed.errors, ...empty };
    const filename = typeof input.filename === 'string' ? input.filename.slice(0, 120) : null;
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const o = await this.outlet(q, outletId);
      if (!o.online_channels.some((c) => c.channel === channel)) throw new BadRequestException('kanal ini belum diaktifkan di outlet (Pengaturan → Outlet)');
      const dates = parsed.rows.map((r) => r.date).sort();
      const report = (await q.query<{ id: string }>(
        'insert into channel_report (tenant_id, outlet_id, channel, filename, date_from, date_to, rows, imported_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id',
        [auth.tenantId, outletId, channel, filename, dates[0], dates[dates.length - 1], parsed.rows.length, auth.userId],
      )).rows[0]!;
      let inserted = 0;
      let updated = 0;
      for (const r of parsed.rows) {
        const res = await q.query<{ inserted: boolean }>(
          `insert into channel_order (tenant_id, outlet_id, channel, ref_key, ref, date, gross, commission, net, report_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           on conflict (outlet_id, channel, ref_key) do update set ref = excluded.ref, date = excluded.date, gross = excluded.gross, commission = excluded.commission,
             net = excluded.net, report_id = excluded.report_id
           returning (xmax = 0) as inserted`,
          [auth.tenantId, outletId, channel, r.ref.toLowerCase(), r.ref, r.date, r.gross, r.commission, r.net, report.id],
        );
        if (res.rows[0]!.inserted) inserted++; else updated++;
      }
      await q.query("insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, 'channel.report', $3::jsonb)", [auth.tenantId, auth.userId, JSON.stringify({ outletId, channel, rows: parsed.rows.length, inserted, updated, from: dates[0], to: dates[dates.length - 1] })]);
      return { applied: true, errors: [], rows: parsed.rows.length, inserted, updated, dateFrom: dates[0]!, dateTo: dates[dates.length - 1]! };
    });
  }

  /** Daftar baris platform pada rentang beserta pasangannya di POS, dan order online POS yang tidak ditemukan di platform. */
  async reconciliation(auth: ApiAuth, outletId: string, params: { from?: string; to?: string; range?: string }, now: number) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const o = await this.outlet(q, outletId);
      const r = resolveRange(o.utc_offset_minutes, params, now);
      const fromMs = startOfLocalDay(r.from, o.utc_offset_minutes);
      const toMs = startOfLocalDay(r.to, o.utc_offset_minutes) + DAY_MS;
      const events = (await q.query<EventRow>(
        `select ${EVENT_COLUMNS} from event where outlet_id = $1 and type = any($2::text[]) and device_time_ms >= $3 and device_time_ms < $4 order by device_id, seq`,
        [outletId, EVENT_TYPES, fromMs - 2 * DAY_MS, Math.max(toMs, now) + DAY_MS],
      )).rows.map(rowToEvent);
      const pos = posOnlineOrders(events, o.utc_offset_minutes).filter((p) => p.date >= r.from && p.date <= r.to);
      const posByKey = new Map<string, (typeof pos)[number]>();
      for (const p of pos) if (!posByKey.has(`${p.channel}:${p.ref.toLowerCase()}`)) posByKey.set(`${p.channel}:${p.ref.toLowerCase()}`, p);
      const platform = (await q.query<OrderRow>('select channel, ref, date, gross, commission, net from channel_order where outlet_id = $1 and date >= $2 and date <= $3 order by date, ref', [outletId, r.from, r.to])).rows;
      const seen = new Set<string>();
      const rows = platform.map((p) => {
        const key = `${p.channel}:${p.ref.toLowerCase()}`;
        seen.add(key);
        const m = posByKey.get(key);
        const status = !m ? 'UNRECORDED' : Math.abs(m.amount - p.gross) > Math.max(1_000, Math.round(p.gross * 0.015)) ? 'AMOUNT' : 'OK';
        return { ...p, status, pos: m ? { orderId: m.orderId, amount: m.amount, actorId: m.actorId } : null };
      });
      // Order POS tanpa pasangan: hanya yang berada dalam cakupan tanggal laporan kanalnya yang layak dicurigai; sisanya "belum ada laporan".
      const cover = new Map<string, [string, string]>();
      for (const p of platform) {
        const c = cover.get(p.channel);
        cover.set(p.channel, c ? [p.date < c[0] ? p.date : c[0], p.date > c[1] ? p.date : c[1]] : [p.date, p.date]);
      }
      const missing = pos.filter((p) => !seen.has(`${p.channel}:${p.ref.toLowerCase()}`)).map((p) => {
        const c = cover.get(p.channel);
        return { channel: p.channel, ref: p.ref, date: p.date, amount: p.amount, orderId: p.orderId, actorId: p.actorId, status: c && p.date >= c[0] && p.date <= c[1] ? 'MISSING' : 'NO_REPORT' };
      });
      const sum = (f: (x: OrderRow) => number) => platform.reduce((s, x) => s + f(x), 0);
      return { range: { from: r.from, to: r.to }, rows, missing, totals: { orders: platform.length, gross: sum((x) => x.gross), commission: sum((x) => x.commission), net: sum((x) => x.net) } };
    });
  }
}
