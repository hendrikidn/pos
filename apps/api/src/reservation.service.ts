import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiAuth, DeviceAuth } from './auth';
import { Database } from './db/database';
import type { Queryable } from './db/driver';
import { CLOCK, type Clock } from './pipeline.service';
import { appliedDeposits } from './reservation-store';
import {
  DEFAULT_DURATION_MIN, depositRemaining, endMs, HORIZON_DAYS, MAX_DEPOSIT, MAX_PARTY, NO_SHOW_GRACE_MS, overlaps, SEAT_EARLY_MS,
  type ReservationStatus, type SettleKind,
} from './reservation';
import { DAY_MS, localDate, startOfLocalDay } from './sales-report';
import { validPhone } from './web-order';

const need = (ok: unknown, message: string): void => {
  if (!ok) throw new BadRequestException(message);
};
const num = (v: unknown) => Number(v);
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max ? v.trim() : null);

export interface ReservationInput { guestName?: unknown; phone?: unknown; partySize?: unknown; start?: unknown; durationMin?: unknown; tableNo?: unknown; note?: unknown }

interface Row {
  id: string; outlet_id: string; guest_name: string; phone: string | null; party_size: number; start_ms: number; duration_min: number; table_no: string | null; status: ReservationStatus;
  note: string | null; created_by: string; status_by: string | null; status_at_ms: number | null; status_reason: string | null;
  deposit: string; deposit_method: 'CASH' | 'TRANSFER' | null; deposit_by: string | null; deposit_at_ms: number | null;
  settle_kind: SettleKind | null; settle_amount: string | null; settle_by: string | null; settle_at_ms: number | null; settle_reason: string | null;
}
const COLS = 'id, outlet_id, guest_name, phone, party_size, start_ms, duration_min, table_no, status, note, created_by, status_by, status_at_ms, status_reason, deposit, deposit_method, deposit_by, deposit_at_ms, settle_kind, settle_amount, settle_by, settle_at_ms, settle_reason';

function view(r: Row, applied: number) {
  const deposit = num(r.deposit);
  return {
    id: num(r.id), outletId: r.outlet_id, guestName: r.guest_name, phone: r.phone, partySize: r.party_size, start: num(r.start_ms), durationMin: r.duration_min,
    tableNo: r.table_no, status: r.status, note: r.note, createdBy: r.created_by, statusBy: r.status_by, statusAt: r.status_at_ms === null ? null : num(r.status_at_ms), statusReason: r.status_reason,
    deposit, depositMethod: r.deposit_method, depositBy: r.deposit_by, depositAt: r.deposit_at_ms === null ? null : num(r.deposit_at_ms),
    applied, remaining: depositRemaining({ deposit, settleKind: r.settle_kind }, applied),
    settle: r.settle_kind ? { kind: r.settle_kind, amount: num(r.settle_amount), by: r.settle_by, at: r.settle_at_ms === null ? null : num(r.settle_at_ms), reason: r.settle_reason } : null,
  };
}

@Injectable()
export class ReservationService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private audit(q: Queryable, auth: { tenantId: string; userId: string }, action: string, detail: object) {
    return q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [auth.tenantId, auth.userId, action, JSON.stringify(detail)]);
  }

  private async outlet(q: Queryable, outletId: string) {
    const o = (await q.query<{ utc_offset_minutes: number; tables: { no: string }[] | null }>('select utc_offset_minutes, tables from outlet where id = $1', [outletId])).rows[0];
    if (!o) throw new NotFoundException('outlet tidak ditemukan');
    return o;
  }

  private async load(q: Queryable, id: number, lock = false): Promise<Row> {
    const r = (await q.query<Row>(`select ${COLS} from reservation where id = $1${lock ? ' for update' : ''}`, [id])).rows[0];
    if (!r) throw new NotFoundException('reservasi tidak ditemukan');
    return r;
  }

  /** Tanggal lokal outlet (YYYY-MM-DD) → awal harinya; null bila tanggal tidak ada. */
  private day(date: unknown, off: number): number | null {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const ms = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) return null;
    return startOfLocalDay(date, off);
  }

  async list(auth: ApiAuth, outletId: string, q2: { from?: string; to?: string }, now = this.clock()) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const o = await this.outlet(q, outletId);
      const today = localDate(now, o.utc_offset_minutes);
      const from = q2.from === undefined ? this.day(today, o.utc_offset_minutes)! : this.day(q2.from, o.utc_offset_minutes);
      const to = q2.to === undefined ? from === null ? null : from + 7 * DAY_MS : this.day(q2.to, o.utc_offset_minutes);
      need(from !== null && to !== null, 'tanggal tidak valid');
      const toMs = q2.to === undefined ? to! : to! + DAY_MS;
      need(toMs > from! && toMs - from! <= 93 * DAY_MS, 'rentang maksimal 93 hari');
      const rows = (await q.query<Row>(`select ${COLS} from reservation where outlet_id = $1 and start_ms >= $2 and start_ms < $3 order by start_ms, id`, [outletId, from, toMs])).rows;
      const applied = await appliedDeposits(q, outletId, rows.map((r) => num(r.id)));
      return {
        range: { from: localDate(from!, o.utc_offset_minutes), to: localDate(toMs - 1, o.utc_offset_minutes) },
        reservations: rows.map((r) => view(r, applied.get(num(r.id)) ?? 0)),
        tables: o.tables?.map((t) => t.no) ?? [],
      };
    });
  }

  /** Validasi isian dan bentrok meja; mengembalikan nilai yang sudah bersih. */
  private async check(q: Queryable, outletId: string, input: ReservationInput, now: number, minStart: number, selfId: number | null) {
    const guestName = text(input.guestName, 80);
    need(guestName, 'nama tamu wajib (maks. 80 karakter)');
    const phone = input.phone === undefined || input.phone === null || input.phone === '' ? null : text(input.phone, 24);
    need(input.phone === undefined || input.phone === null || input.phone === '' || (phone !== null && validPhone(phone)), 'nomor telepon tidak valid');
    need(Number.isInteger(input.partySize) && (input.partySize as number) >= 1 && (input.partySize as number) <= MAX_PARTY, `jumlah tamu 1–${MAX_PARTY}`);
    const start = typeof input.start === 'number' ? input.start : Number.NaN;
    need(Number.isFinite(start), 'jam reservasi tidak valid');
    need(start >= minStart, 'jam reservasi sudah lewat');
    need(start <= now + HORIZON_DAYS * DAY_MS, `reservasi maksimal ${HORIZON_DAYS} hari ke depan`);
    const durationMin = input.durationMin === undefined ? DEFAULT_DURATION_MIN : input.durationMin;
    need(Number.isInteger(durationMin) && (durationMin as number) >= 30 && (durationMin as number) <= 480, 'lama reservasi 30–480 menit');
    const note = input.note === undefined || input.note === null || input.note === '' ? null : text(input.note, 200);
    need(input.note === undefined || input.note === null || input.note === '' || note !== null, 'catatan maksimal 200 karakter');
    let tableNo: string | null = null;
    if (input.tableNo !== undefined && input.tableNo !== null && input.tableNo !== '') {
      tableNo = text(input.tableNo, 6);
      need(tableNo, 'nomor meja tidak valid');
      const o = await this.outlet(q, outletId);
      if (o.tables && o.tables.length > 0) need(o.tables.some((t) => t.no === tableNo), `meja ${tableNo} tidak ada di denah outlet`);
      const clash = (await q.query<{ id: string; start_ms: number; duration_min: number; guest_name: string }>(
        "select id, start_ms, duration_min, guest_name from reservation where outlet_id = $1 and table_no = $2 and status in ('BOOKED', 'SEATED') and ($3::bigint is null or id <> $3)", [outletId, tableNo, selfId],
      )).rows.find((r) => overlaps({ startMs: start, durationMin: durationMin as number }, { startMs: num(r.start_ms), durationMin: r.duration_min }));
      if (clash) throw new ConflictException(`meja ${tableNo} sudah dipesan untuk reservasi #${clash.id} (${clash.guest_name}) pada jam yang bertumpuk`);
    }
    return { guestName: guestName!, phone, partySize: input.partySize as number, start, durationMin: durationMin as number, tableNo, note };
  }

  async create(auth: ApiAuth, outletId: string, input: ReservationInput, now = this.clock()): Promise<{ id: number }> {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      await this.outlet(q, outletId);
      // Kunci per outlet agar dua reservasi serentak tidak sama-sama lolos pemeriksaan bentrok.
      await q.query('select pg_advisory_xact_lock(hashtext($1))', [`reservation:${outletId}`]);
      const v = await this.check(q, outletId, input, now, now - 3_600_000, null);
      const id = num((await q.query<{ id: string }>(
        `insert into reservation (tenant_id, outlet_id, guest_name, phone, party_size, start_ms, duration_min, table_no, note, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [auth.tenantId, outletId, v.guestName, v.phone, v.partySize, v.start, v.durationMin, v.tableNo, v.note, auth.userId],
      )).rows[0]!.id);
      await this.audit(q, auth, 'reservation.create', { id, outletId, start: v.start, partySize: v.partySize, tableNo: v.tableNo });
      return { id };
    });
  }

  async update(auth: ApiAuth, id: number, input: ReservationInput, now = this.clock()): Promise<void> {
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const cur = await this.load(q, id);
      await q.query('select pg_advisory_xact_lock(hashtext($1))', [`reservation:${cur.outlet_id}`]);
      const r = await this.load(q, id, true);
      if (r.status !== 'BOOKED') throw new ConflictException('hanya reservasi yang masih dipesan yang bisa diubah');
      const v = await this.check(q, r.outlet_id, input, now, Math.min(now - 3_600_000, num(r.start_ms)), id);
      await q.query(
        'update reservation set guest_name = $2, phone = $3, party_size = $4, start_ms = $5, duration_min = $6, table_no = $7, note = $8 where id = $1',
        [id, v.guestName, v.phone, v.partySize, v.start, v.durationMin, v.tableNo, v.note],
      );
      await this.audit(q, auth, 'reservation.update', { id, from: { start: num(r.start_ms), tableNo: r.table_no, partySize: r.party_size }, to: { start: v.start, tableNo: v.tableNo, partySize: v.partySize } });
    });
  }

  async setDeposit(auth: ApiAuth, id: number, input: { amount?: unknown; method?: unknown }, now = this.clock()): Promise<void> {
    need(Number.isInteger(input.amount) && (input.amount as number) > 0 && (input.amount as number) <= MAX_DEPOSIT, `uang muka harus bilangan bulat rupiah 1–${MAX_DEPOSIT.toLocaleString('id-ID')}`);
    need(input.method === 'CASH' || input.method === 'TRANSFER', 'metode uang muka harus CASH atau TRANSFER');
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await this.load(q, id, true);
      if (r.status !== 'BOOKED') throw new ConflictException('uang muka hanya bisa dicatat untuk reservasi yang masih dipesan');
      if (num(r.deposit) > 0) throw new ConflictException('reservasi ini sudah punya uang muka');
      await q.query('update reservation set deposit = $2, deposit_method = $3, deposit_by = $4, deposit_at_ms = $5 where id = $1', [id, input.amount, input.method, auth.userId, now]);
      await this.audit(q, auth, 'reservation.deposit', { id, amount: input.amount, method: input.method });
    });
  }

  private async seatCore(q: Queryable, id: number, actor: { tenantId: string; userId: string }, outletId: string | null, now: number) {
    const r = await this.load(q, id, true);
    if (outletId !== null && r.outlet_id !== outletId) throw new NotFoundException('reservasi tidak ditemukan');
    if (r.status !== 'BOOKED') throw new ConflictException('reservasi ini sudah tidak berstatus dipesan');
    if (now < num(r.start_ms) - SEAT_EARLY_MS) throw new BadRequestException('terlalu awal: tamu baru boleh didudukkan 2 jam sebelum jam reservasi');
    if (now > endMs({ startMs: num(r.start_ms), durationMin: r.duration_min })) throw new BadRequestException('jam reservasi sudah lewat: ubah jadwalnya atau tandai tidak datang');
    await q.query("update reservation set status = 'SEATED', status_by = $2, status_at_ms = $3 where id = $1", [id, actor.userId, now]);
    await this.audit(q, actor, 'reservation.seat', { id, tableNo: r.table_no });
    return r;
  }

  /** Dudukkan tamu dari dashboard. */
  async seat(auth: ApiAuth, id: number, now = this.clock()): Promise<void> {
    await this.db.tenantTx(auth.tenantId, async (q) => void (await this.seatCore(q, id, auth, null, now)));
  }

  /** Dudukkan tamu dari terminal POS (hanya reservasi outlet terminal itu). */
  async seatFromDevice(device: DeviceAuth, id: number, now = this.clock()): Promise<{ tableNo: string | null; guestName: string }> {
    return this.db.tenantTx(device.tenantId, async (q) => {
      const r = await this.seatCore(q, id, { tenantId: device.tenantId, userId: `device:${device.deviceId}` }, device.outletId, now);
      return { tableNo: r.table_no, guestName: r.guest_name };
    });
  }

  async noShow(auth: ApiAuth, id: number, now = this.clock()): Promise<void> {
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await this.load(q, id, true);
      if (r.status !== 'BOOKED') throw new ConflictException('reservasi ini sudah tidak berstatus dipesan');
      if (now < num(r.start_ms) + NO_SHOW_GRACE_MS) throw new BadRequestException('tamu baru bisa ditandai tidak datang 15 menit setelah jam reservasi');
      await q.query("update reservation set status = 'NO_SHOW', status_by = $2, status_at_ms = $3 where id = $1", [id, auth.userId, now]);
      await this.audit(q, auth, 'reservation.no_show', { id, deposit: num(r.deposit) });
    });
  }

  async cancel(auth: ApiAuth, id: number, reason: unknown, now = this.clock()): Promise<void> {
    const why = text(reason, 140);
    need(why, 'alasan pembatalan wajib');
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await this.load(q, id, true);
      if (r.status !== 'BOOKED') throw new ConflictException('hanya reservasi yang masih dipesan yang bisa dibatalkan');
      await q.query("update reservation set status = 'CANCELED', status_by = $2, status_at_ms = $3, status_reason = $4 where id = $1", [id, auth.userId, now, why]);
      await this.audit(q, auth, 'reservation.cancel', { id, reason: why, deposit: num(r.deposit) });
    });
  }

  /**
   * Menyelesaikan sisa uang muka: dikembalikan ke tamu atau dihanguskan (jadi pendapatan). Pemisahan tugas: yang mencatat uang muka tidak boleh
   * menyelesaikannya sendiri kecuali owner.
   */
  async settle(auth: ApiAuth, id: number, input: { kind?: unknown; reason?: unknown }, now = this.clock()): Promise<{ amount: number }> {
    need(input.kind === 'REFUND' || input.kind === 'FORFEIT', 'kind harus REFUND atau FORFEIT');
    const why = text(input.reason, 140);
    need(why, 'alasan wajib');
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await this.load(q, id, true);
      if (num(r.deposit) <= 0) throw new ConflictException('reservasi ini tidak punya uang muka');
      if (r.settle_kind) throw new ConflictException('uang muka ini sudah diselesaikan');
      if (input.kind === 'FORFEIT' && r.status !== 'NO_SHOW' && r.status !== 'CANCELED') throw new ConflictException('uang muka hanya bisa dihanguskan untuk reservasi yang tidak datang atau dibatalkan');
      if (input.kind === 'REFUND' && r.status === 'BOOKED') throw new ConflictException('batalkan reservasi dulu sebelum uang muka dikembalikan');
      if (auth.role !== 'OWNER' && r.deposit_by === auth.userId) throw new ForbiddenException('uang muka ini Anda catat sendiri: pengembalian atau penghangusan harus oleh pengguna lain atau owner');
      const applied = (await appliedDeposits(q, r.outlet_id, [id])).get(id) ?? 0;
      const amount = depositRemaining({ deposit: num(r.deposit), settleKind: null }, applied);
      if (amount <= 0) throw new ConflictException('uang muka sudah terpakai seluruhnya sebagai pembayaran');
      await q.query('update reservation set settle_kind = $2, settle_amount = $3, settle_by = $4, settle_at_ms = $5, settle_reason = $6 where id = $1', [id, input.kind, amount, auth.userId, now, why]);
      await this.audit(q, auth, input.kind === 'REFUND' ? 'reservation.refund' : 'reservation.forfeit', { id, amount, reason: why });
      return { amount };
    });
  }

  /** Reservasi yang relevan untuk kasir: dari 3 jam lalu sampai 24 jam ke depan yang masih dipesan atau sudah duduk. Tanpa nomor telepon. */
  async board(device: DeviceAuth, now = this.clock()) {
    return this.db.tenantTx(device.tenantId, async (q) => {
      const rows = (await q.query<Row>(
        // Yang masih dipesan hanya relevan sampai 3 jam setelah jamnya; yang sudah duduk tetap tampil 8 jam (masih makan, uang mukanya belum dipakai).
        `select ${COLS} from reservation where outlet_id = $1 and ((status = 'BOOKED' and start_ms >= $2) or (status = 'SEATED' and start_ms >= $4)) and start_ms < $3 order by start_ms, id`,
        [device.outletId, now - 3 * 3_600_000, now + DAY_MS, now - 8 * 3_600_000],
      )).rows;
      const applied = await appliedDeposits(q, device.outletId, rows.map((r) => num(r.id)));
      return {
        at: now,
        reservations: rows.map((r) => {
          const v = view(r, applied.get(num(r.id)) ?? 0);
          return { id: v.id, guestName: v.guestName, partySize: v.partySize, start: v.start, durationMin: v.durationMin, tableNo: v.tableNo, status: v.status, depositRemaining: v.remaining };
        }),
      };
    });
  }

  /** Data jurnal uang muka: diterima (tanggal catat) dan diselesaikan (tanggal selesai), untuk satu outlet dan rentang tanggal lokal. */
  async journalRows(q: Queryable, outletId: string, fromMs: number, toMs: number) {
    const rows = (await q.query<Row>(
      `select ${COLS} from reservation where outlet_id = $1 and deposit > 0 and ((deposit_at_ms >= $2 and deposit_at_ms < $3) or (settle_at_ms >= $2 and settle_at_ms < $3))`, [outletId, fromMs, toMs],
    )).rows;
    return rows.map((r) => ({
      id: num(r.id), guest: r.guest_name, deposit: num(r.deposit), method: r.deposit_method!, depositAt: num(r.deposit_at_ms),
      settle: r.settle_kind ? { kind: r.settle_kind, amount: num(r.settle_amount), at: num(r.settle_at_ms) } : null,
    }));
  }
}
