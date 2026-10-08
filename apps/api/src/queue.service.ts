import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiAuth, DeviceAuth } from './auth';
import { Database } from './db/database';
import type { Queryable } from './db/driver';
import { CLOCK, type Clock } from './pipeline.service';
import {
  checkCall, estimateWaitMin, labelOf, MAX_PARTY, MAX_WAITING, NO_SHOW_AFTER_MS, type QueueTicketFacts, type TicketStatus,
} from './queue';
import { localDate } from './sales-report';
import { phoneKey, SLUG_RE, validPhone } from './web-order';

const need = (ok: unknown, message: string): void => {
  if (!ok) throw new BadRequestException(message);
};
const num = (v: unknown) => Number(v);
const clean = (v: unknown, min: number, max: number): string | null => {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  return s.length >= min && s.length <= max ? s : null;
};
const NOT_FOUND = 'antrian tidak ditemukan';
const TICKETS_PER_IP_PER_HOUR = 4;
const READS_PER_IP_PER_MINUTE = 240;
const MAX_RECALLS = 5;

export interface TicketInput { partySize?: unknown; name?: unknown; phone?: unknown; website?: unknown; staffId?: unknown }

interface Row {
  id: string; outlet_id: string; day: string; seq: number; token: string; party_size: number; name: string | null; phone: string | null; source: 'SELF' | 'STAFF'; status: TicketStatus;
  created_at_ms: number; created_by: string | null; called_at_ms: number | null; call_count: number; called_by: string | null; jump_reason: string | null; jump_note: string | null;
  jumped_over: string[] | null; seated_at_ms: number | null; seated_by: string | null; table_no: string | null; closed_by: string | null; closed_at_ms: number | null; closed_reason: string | null;
}
const COLS = 'id, outlet_id, day, seq, token, party_size, name, phone, source, status, created_at_ms, created_by, called_at_ms, call_count, called_by, jump_reason, jump_note, jumped_over, seated_at_ms, seated_by, table_no, closed_by, closed_at_ms, closed_reason';
const facts = (r: Row): QueueTicketFacts => ({ id: num(r.id), seq: r.seq, partySize: r.party_size, status: r.status, createdAtMs: num(r.created_at_ms) });

interface QueueOutlet { id: string; tenant_id: string; name: string; merchant_name: string | null; utc_offset_minutes: number; tables: { no: string }[] | null; queue_enabled?: boolean }

@Injectable()
export class QueueService {
  private readonly takeHits = new Map<string, { count: number; resetAt: number }>();
  private readonly readHits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private limit(map: Map<string, { count: number; resetAt: number }>, caller: string, max: number, windowMs: number, message: string): void {
    const now = this.clock();
    const h = map.get(caller);
    if (!h || h.resetAt <= now) {
      if (map.size > 5_000) map.clear();
      map.set(caller, { count: 1, resetAt: now + windowMs });
    } else if (++h.count > max) throw new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
  }

  private audit(q: Queryable, tenantId: string, actor: string, action: string, detail: object) {
    return q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [tenantId, actor, action, JSON.stringify(detail)]);
  }

  private async outletInfo(q: Queryable, outletId: string): Promise<QueueOutlet> {
    const o = (await q.query<QueueOutlet>('select id, tenant_id, name, merchant_name, utc_offset_minutes, tables, queue_enabled from outlet where id = $1', [outletId])).rows[0];
    if (!o) throw new NotFoundException('outlet tidak ditemukan');
    return o;
  }

  /** Hari ini menurut outlet; tiket hari-hari sebelumnya yang masih menunggu atau dipanggil dinyatakan kedaluwarsa. */
  private async today(q: Queryable, o: { id: string; utc_offset_minutes: number }, now: number): Promise<string> {
    const day = localDate(now, o.utc_offset_minutes);
    await q.query("update queue_ticket set status = 'EXPIRED' where outlet_id = $1 and day < $2 and status in ('WAITING', 'CALLED')", [o.id, day]);
    return day;
  }

  /** Staf yang melakukan aksi: id staf bila disebut dan dikenal, kalau tidak terminalnya. */
  private async actor(q: Queryable, device: DeviceAuth, staffId: unknown): Promise<string> {
    if (typeof staffId === 'string' && staffId !== '') {
      if ((await q.query('select 1 from staff where id = $1', [staffId])).rowCount === 0) throw new BadRequestException('staf tidak dikenal');
      return staffId;
    }
    return `device:${device.deviceId}`;
  }

  // ---------- publik ----------

  private async bySlug(slug: string): Promise<QueueOutlet> {
    if (!SLUG_RE.test(slug)) throw new NotFoundException(NOT_FOUND);
    const o = (await this.db.admin.query<QueueOutlet>(
      `select o.id, o.tenant_id, o.name, o.merchant_name, o.utc_offset_minutes, o.tables from outlet o join tenant t on t.id = o.tenant_id
       where o.web_slug = $1 and o.queue_enabled and t.suspended_at is null`, [slug],
    )).rows[0];
    if (!o) throw new NotFoundException(NOT_FOUND);
    return o;
  }

  private async aheadOf(q: Queryable, t: Row): Promise<number> {
    if (t.status !== 'WAITING') return 0;
    return num((await q.query<{ n: string }>("select count(*) as n from queue_ticket where outlet_id = $1 and day = $2 and status = 'WAITING' and seq < $3", [t.outlet_id, t.day, t.seq])).rows[0]!.n);
  }

  async publicBoard(slug: string, caller: string) {
    this.limit(this.readHits, caller, READS_PER_IP_PER_MINUTE, 60_000, 'terlalu banyak permintaan; coba lagi sebentar');
    const o = await this.bySlug(slug);
    const now = this.clock();
    return this.db.tenantTx(o.tenant_id, async (q) => {
      const day = await this.today(q, o, now);
      const waiting = num((await q.query<{ n: string }>("select count(*) as n from queue_ticket where outlet_id = $1 and day = $2 and status = 'WAITING'", [o.id, day])).rows[0]!.n);
      const calling = (await q.query<{ seq: number; table_no: string | null }>(
        "select seq, table_no from queue_ticket where outlet_id = $1 and day = $2 and status = 'CALLED' order by called_at_ms desc limit 6", [o.id, day],
      )).rows.map((r) => ({ label: labelOf(r.seq) }));
      return { name: o.merchant_name ?? o.name, waiting, estimateMin: estimateWaitMin(waiting), calling, at: now };
    });
  }

  async publicTake(slug: string, input: TicketInput, caller: string): Promise<{ token: string; label: string; ahead: number; estimateMin: number }> {
    if (typeof input.website === 'string' && input.website.trim() !== '') return { token: randomBytes(16).toString('base64url'), label: 'A000', ahead: 0, estimateMin: 0 };
    this.limit(this.readHits, caller, READS_PER_IP_PER_MINUTE, 60_000, 'terlalu banyak permintaan; coba lagi sebentar');
    const o = await this.bySlug(slug);
    need(Number.isInteger(input.partySize) && (input.partySize as number) >= 1 && (input.partySize as number) <= MAX_PARTY, `jumlah tamu 1–${MAX_PARTY}`);
    const name = input.name === undefined || input.name === null || input.name === '' ? null : clean(input.name, 2, 40);
    need(input.name === undefined || input.name === null || input.name === '' || name !== null, 'nama 2–40 karakter');
    const phone = input.phone === undefined || input.phone === null || input.phone === '' ? null : clean(input.phone, 8, 20);
    need(input.phone === undefined || input.phone === null || input.phone === '' || (phone !== null && validPhone(phone)), 'nomor telepon tidak valid');
    const now = this.clock();
    return this.db.tenantTx(o.tenant_id, async (q) => {
      const day = await this.today(q, o, now);
      await q.query('select pg_advisory_xact_lock(hashtext($1))', [`queue:${o.id}`]);
      const waiting = num((await q.query<{ n: string }>("select count(*) as n from queue_ticket where outlet_id = $1 and day = $2 and status = 'WAITING'", [o.id, day])).rows[0]!.n);
      if (waiting >= MAX_WAITING) throw new HttpException('antrian sedang penuh; silakan datang ke kasir', HttpStatus.TOO_MANY_REQUESTS);
      if (phone) {
        const active = (await q.query<{ phone: string }>("select phone from queue_ticket where outlet_id = $1 and day = $2 and phone is not null and status in ('WAITING', 'CALLED')", [o.id, day])).rows;
        if (active.some((r) => phoneKey(r.phone) === phoneKey(phone))) throw new ConflictException('nomor ini sudah punya tiket antrian yang aktif');
      }
      this.limit(this.takeHits, caller, TICKETS_PER_IP_PER_HOUR, 3_600_000, 'terlalu banyak tiket dari perangkat ini; silakan datang ke kasir');
      const seq = num((await q.query<{ n: string }>('select coalesce(max(seq), 0) + 1 as n from queue_ticket where outlet_id = $1 and day = $2', [o.id, day])).rows[0]!.n);
      const token = randomBytes(16).toString('base64url');
      await q.query(
        `insert into queue_ticket (tenant_id, outlet_id, day, seq, token, party_size, name, phone, source, created_at_ms, caller_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'SELF', $9, $10)`,
        [o.tenant_id, o.id, day, seq, token, input.partySize, name, phone, now, createHash('sha256').update(caller).digest('hex').slice(0, 16)],
      );
      return { token, label: labelOf(seq), ahead: waiting, estimateMin: estimateWaitMin(waiting) };
    });
  }

  private async byToken(token: string) {
    if (!/^[A-Za-z0-9_-]{22}$/.test(token)) throw new NotFoundException(NOT_FOUND);
    const r = (await this.db.admin.query<Row & { tenant_id: string }>(`select tenant_id, ${COLS} from queue_ticket where token = $1`, [token])).rows[0];
    if (!r) throw new NotFoundException(NOT_FOUND);
    return r;
  }

  async publicTrack(token: string, caller: string) {
    this.limit(this.readHits, caller, READS_PER_IP_PER_MINUTE, 60_000, 'terlalu banyak permintaan; coba lagi sebentar');
    const r = await this.byToken(token);
    return this.db.tenantTx(r.tenant_id, async (q) => {
      const o = await this.outletInfo(q, r.outlet_id);
      const day = await this.today(q, o, this.clock());
      const t = (await q.query<Row>(`select ${COLS} from queue_ticket where id = $1`, [r.id])).rows[0]!;
      const ahead = await this.aheadOf(q, t);
      return {
        outletName: o.merchant_name ?? o.name, label: labelOf(t.seq), status: t.status, partySize: t.party_size, ahead, estimateMin: estimateWaitMin(ahead),
        callCount: t.call_count, calledAt: t.called_at_ms === null ? null : num(t.called_at_ms), tableNo: t.status === 'SEATED' ? t.table_no : null, today: t.day === day,
      };
    });
  }

  async publicCancel(token: string, caller: string): Promise<void> {
    this.limit(this.readHits, caller, READS_PER_IP_PER_MINUTE, 60_000, 'terlalu banyak permintaan; coba lagi sebentar');
    const r = await this.byToken(token);
    await this.db.tenantTx(r.tenant_id, async (q) => {
      const res = await q.query("update queue_ticket set status = 'CANCELED', closed_by = 'pelanggan', closed_at_ms = $2, closed_reason = 'dibatalkan pelanggan' where id = $1 and status in ('WAITING', 'CALLED')", [r.id, this.clock()]);
      if (res.rowCount === 0) throw new ConflictException('tiket ini sudah tidak aktif');
    });
  }

  // ---------- dashboard ----------

  async settings(auth: ApiAuth, outletId: string) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const o = (await q.query<{ web_slug: string | null; queue_enabled: boolean }>('select web_slug, queue_enabled from outlet where id = $1', [outletId])).rows[0];
      if (!o) throw new NotFoundException('outlet tidak ditemukan');
      return { slug: o.web_slug, enabled: o.queue_enabled };
    });
  }

  async setSettings(auth: ApiAuth, outletId: string, input: { enabled?: unknown }): Promise<void> {
    need(typeof input.enabled === 'boolean', 'enabled harus true atau false');
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const o = (await q.query<{ web_slug: string | null }>('select web_slug from outlet where id = $1', [outletId])).rows[0];
      if (!o) throw new NotFoundException('outlet tidak ditemukan');
      need(!(input.enabled && !o.web_slug), 'atur alamat toko dulu di halaman Toko Web (alamat itu dipakai antrian juga)');
      await q.query('update outlet set queue_enabled = $2 where id = $1', [outletId, input.enabled]);
      await this.audit(q, auth.tenantId, auth.userId, 'queue.settings', { outletId, enabled: input.enabled });
    });
  }

  async dayView(auth: ApiAuth, outletId: string, day: string | undefined, now = this.clock()) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const o = await this.outletInfo(q, outletId);
      const today = await this.today(q, o, now);
      const d = day ?? today;
      need(/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, 'tanggal tidak valid');
      const rows = (await q.query<Row>(`select ${COLS} from queue_ticket where outlet_id = $1 and day = $2 order by seq`, [outletId, d])).rows;
      const waits = rows.filter((r) => r.called_at_ms !== null).map((r) => (num(r.called_at_ms) - num(r.created_at_ms)) / 60_000);
      const count = (s: TicketStatus) => rows.filter((r) => r.status === s).length;
      return {
        day: d,
        stats: {
          total: rows.length, seated: count('SEATED'), noShow: count('NO_SHOW'), canceled: count('CANCELED') + count('EXPIRED'), waiting: count('WAITING') + count('CALLED'),
          avgWaitMin: waits.length === 0 ? null : Math.round(waits.reduce((s, w) => s + w, 0) / waits.length), jumps: rows.filter((r) => r.jump_reason !== null).length,
        },
        tickets: rows.map((r) => ({
          id: num(r.id), label: labelOf(r.seq), partySize: r.party_size, name: r.name, phone: r.phone, source: r.source, status: r.status, createdAt: num(r.created_at_ms),
          calledAt: r.called_at_ms === null ? null : num(r.called_at_ms), callCount: r.call_count, calledBy: r.called_by, jumpReason: r.jump_reason, jumpNote: r.jump_note, jumpedOver: r.jumped_over,
          seatedAt: r.seated_at_ms === null ? null : num(r.seated_at_ms), seatedBy: r.seated_by, tableNo: r.table_no, closedReason: r.closed_reason,
        })),
      };
    });
  }

  // ---------- terminal POS ----------

  async board(device: DeviceAuth, now = this.clock()) {
    return this.db.tenantTx(device.tenantId, async (q) => {
      const o = await this.outletInfo(q, device.outletId);
      const day = await this.today(q, o, now);
      const rows = (await q.query<Row>(`select ${COLS} from queue_ticket where outlet_id = $1 and day = $2 and status in ('WAITING', 'CALLED') order by seq`, [device.outletId, day])).rows;
      return {
        at: now,
        enabled: o.queue_enabled === true,
        tickets: rows.map((r) => ({
          id: num(r.id), label: labelOf(r.seq), partySize: r.party_size, name: r.name, phone: r.phone, status: r.status as 'WAITING' | 'CALLED', createdAt: num(r.created_at_ms),
          calledAt: r.called_at_ms === null ? null : num(r.called_at_ms), callCount: r.call_count,
        })),
      };
    });
  }

  /** Kasir menambahkan tamu yang datang langsung ke antrian. */
  async add(device: DeviceAuth, input: TicketInput, now = this.clock()): Promise<{ id: number; label: string }> {
    need(Number.isInteger(input.partySize) && (input.partySize as number) >= 1 && (input.partySize as number) <= MAX_PARTY, `jumlah tamu 1–${MAX_PARTY}`);
    const name = input.name === undefined || input.name === null || input.name === '' ? null : clean(input.name, 2, 40);
    need(input.name === undefined || input.name === null || input.name === '' || name !== null, 'nama 2–40 karakter');
    return this.db.tenantTx(device.tenantId, async (q) => {
      const o = await this.outletInfo(q, device.outletId);
      const day = await this.today(q, o, now);
      await q.query('select pg_advisory_xact_lock(hashtext($1))', [`queue:${o.id}`]);
      const waiting = num((await q.query<{ n: string }>("select count(*) as n from queue_ticket where outlet_id = $1 and day = $2 and status = 'WAITING'", [o.id, day])).rows[0]!.n);
      if (waiting >= MAX_WAITING) throw new ConflictException('antrian sudah penuh');
      const by = await this.actor(q, device, input.staffId);
      const seq = num((await q.query<{ n: string }>('select coalesce(max(seq), 0) + 1 as n from queue_ticket where outlet_id = $1 and day = $2', [o.id, day])).rows[0]!.n);
      const id = num((await q.query<{ id: string }>(
        `insert into queue_ticket (tenant_id, outlet_id, day, seq, token, party_size, name, source, created_at_ms, created_by) values ($1, $2, $3, $4, $5, $6, $7, 'STAFF', $8, $9) returning id`,
        [device.tenantId, o.id, day, seq, randomBytes(16).toString('base64url'), input.partySize, name, now, by],
      )).rows[0]!.id);
      return { id, label: labelOf(seq) };
    });
  }

  private async loadTicket(q: Queryable, device: DeviceAuth, id: number): Promise<Row> {
    const r = (await q.query<Row>(`select ${COLS} from queue_ticket where id = $1 and outlet_id = $2 for update`, [id, device.outletId])).rows[0];
    if (!r) throw new NotFoundException('tiket tidak ditemukan');
    return r;
  }

  /**
   * Memanggil tiket. Yang paling lama menunggu selalu boleh; selain itu berarti melewati antrian dan wajib beralasan (lihat `checkCall`).
   * Tiket yang sudah dipanggil dipanggil ulang lewat `recall`.
   */
  async call(device: DeviceAuth, id: number, input: { reason?: unknown; note?: unknown; staffId?: unknown }, now = this.clock()): Promise<{ label: string; skipped: string[] }> {
    return this.db.tenantTx(device.tenantId, async (q) => {
      const o = await this.outletInfo(q, device.outletId);
      const day = await this.today(q, o, now);
      await q.query('select pg_advisory_xact_lock(hashtext($1))', [`queue:${o.id}`]);
      const t = await this.loadTicket(q, device, id);
      if (t.day !== day || t.status !== 'WAITING') throw new ConflictException('tiket ini tidak sedang menunggu');
      const waiting = (await q.query<Row>(`select ${COLS} from queue_ticket where outlet_id = $1 and day = $2 and status = 'WAITING' order by seq`, [device.outletId, day])).rows;
      const check = checkCall(waiting.map(facts), facts(t), input.reason, input.note);
      if (!check.ok) throw new BadRequestException(check.message);
      const by = await this.actor(q, device, input.staffId);
      const skipped = waiting.filter((w) => check.skipped.includes(num(w.id))).map((w) => labelOf(w.seq));
      const jump = check.skipped.length > 0;
      await q.query(
        `update queue_ticket set status = 'CALLED', called_at_ms = $2, call_count = 1, called_by = $3, jump_reason = $4, jump_note = $5, jumped_over = $6::jsonb where id = $1`,
        [id, now, by, jump ? input.reason : null, jump && input.reason !== 'TABLE_SIZE' ? clean(input.note, 3, 80) : null, jump ? JSON.stringify(skipped) : null],
      );
      if (jump) await this.audit(q, device.tenantId, by, 'queue.jump', { id, label: labelOf(t.seq), reason: input.reason, skipped });
      return { label: labelOf(t.seq), skipped };
    });
  }

  async recall(device: DeviceAuth, id: number, now = this.clock()): Promise<{ label: string; callCount: number }> {
    return this.db.tenantTx(device.tenantId, async (q) => {
      const t = await this.loadTicket(q, device, id);
      if (t.status !== 'CALLED') throw new ConflictException('hanya tiket yang sedang dipanggil yang bisa dipanggil ulang');
      if (t.call_count >= MAX_RECALLS) throw new ConflictException(`sudah dipanggil ${MAX_RECALLS} kali; tandai tidak datang`);
      await q.query('update queue_ticket set call_count = call_count + 1, called_at_ms = $2 where id = $1', [id, now]);
      return { label: labelOf(t.seq), callCount: t.call_count + 1 };
    });
  }

  /** Mendudukkan tamu yang dipanggil di satu meja; kasir lalu membuat order dine-in di meja itu yang tertaut ke tiket (R49). */
  async seat(device: DeviceAuth, id: number, input: { tableNo?: unknown; staffId?: unknown }, now = this.clock()): Promise<{ label: string; tableNo: string; partySize: number; name: string | null }> {
    const tableNo = clean(input.tableNo, 1, 6);
    need(tableNo, 'nomor meja wajib');
    return this.db.tenantTx(device.tenantId, async (q) => {
      const o = await this.outletInfo(q, device.outletId);
      if (o.tables && o.tables.length > 0) need(o.tables.some((t) => t.no === tableNo), 'nomor meja tidak ada di denah');
      const t = await this.loadTicket(q, device, id);
      if (t.status !== 'CALLED') throw new ConflictException('panggil tiket dulu sebelum mendudukkan');
      const by = await this.actor(q, device, input.staffId);
      await q.query("update queue_ticket set status = 'SEATED', seated_at_ms = $2, seated_by = $3, table_no = $4 where id = $1", [id, now, by, tableNo]);
      await this.audit(q, device.tenantId, by, 'queue.seat', { id, label: labelOf(t.seq), tableNo });
      return { label: labelOf(t.seq), tableNo: tableNo!, partySize: t.party_size, name: t.name };
    });
  }

  async noShow(device: DeviceAuth, id: number, input: { staffId?: unknown }, now = this.clock()): Promise<void> {
    await this.db.tenantTx(device.tenantId, async (q) => {
      const t = await this.loadTicket(q, device, id);
      if (t.status !== 'CALLED') throw new ConflictException('hanya tiket yang sedang dipanggil yang bisa ditandai tidak datang');
      if (now < num(t.called_at_ms) + NO_SHOW_AFTER_MS) throw new BadRequestException('beri waktu 2 menit setelah panggilan terakhir sebelum menandai tidak datang');
      const by = await this.actor(q, device, input.staffId);
      await q.query("update queue_ticket set status = 'NO_SHOW', closed_by = $2, closed_at_ms = $3, closed_reason = $4 where id = $1", [id, by, now, `tidak datang setelah dipanggil ${t.call_count}×`]);
      await this.audit(q, device.tenantId, by, 'queue.no_show', { id, label: labelOf(t.seq), calls: t.call_count });
    });
  }

  async cancel(device: DeviceAuth, id: number, input: { reason?: unknown; staffId?: unknown }, now = this.clock()): Promise<void> {
    const why = clean(input.reason, 3, 80);
    need(why, 'alasan wajib (3–80 karakter)');
    await this.db.tenantTx(device.tenantId, async (q) => {
      const t = await this.loadTicket(q, device, id);
      if (t.status !== 'WAITING' && t.status !== 'CALLED') throw new ConflictException('tiket ini sudah tidak aktif');
      const by = await this.actor(q, device, input.staffId);
      await q.query("update queue_ticket set status = 'CANCELED', closed_by = $2, closed_at_ms = $3, closed_reason = $4 where id = $1", [id, by, now, why]);
      await this.audit(q, device.tenantId, by, 'queue.cancel', { id, label: labelOf(t.seq), reason: why });
    });
  }
}
