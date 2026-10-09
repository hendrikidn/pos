import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiAuth } from './auth';
import { Database } from './db/database';
import type { Queryable } from './db/driver';
import { EVENT_COLUMNS, rowToEvent, type EventRow } from './guard.service';
import { buildIntervals, computePay, MAX_OPEN_MS, netPay, type Interval, type OpenInterval, type PayRule } from './payroll';
import { CLOCK, type Clock } from './pipeline.service';
import { resolveRange } from './report-range';
import { toCsv } from './sales-export';
import { DAY_MS, localDate, startOfLocalDay } from './sales-report';

const need = (ok: unknown, message: string): void => {
  if (!ok) throw new BadRequestException(message);
};
const num = (v: unknown) => Number(v);
const MAX_PAY = 1_000_000_000;

export interface PayInput { payType?: unknown; rate?: unknown; overtimeMultiplier?: unknown }
export interface ManualInput { staffId?: unknown; start?: unknown; end?: unknown; reason?: unknown }
export interface RunInput { from?: unknown; to?: unknown; dailyRegularHours?: unknown }
export interface LineInput { allowance?: unknown; deduction?: unknown; note?: unknown }

type RunStatus = 'DRAFT' | 'FINAL' | 'PAID' | 'CANCELED';

@Injectable()
export class HrService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private audit(q: Queryable, auth: ApiAuth, action: string, detail: object) {
    return q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [auth.tenantId, auth.userId, action, JSON.stringify(detail)]);
  }

  private async outletOffset(q: Queryable, outletId: string): Promise<number> {
    const o = (await q.query<{ utc_offset_minutes: number }>('select utc_offset_minutes from outlet where id = $1', [outletId])).rows[0];
    if (!o) throw new NotFoundException('outlet tidak ditemukan');
    return o.utc_offset_minutes;
  }

  // ---------- tarif gaji ----------

  async listStaffPay(auth: ApiAuth) {
    return this.db.tenantTx(auth.tenantId, async (q) =>
      (await q.query<{ id: string; name: string; role: string; active: boolean; pay_type: string | null; rate: number | null; overtime_multiplier: string | null }>(
        `select s.id, s.name, s.role, s.active, p.pay_type, p.rate, p.overtime_multiplier from staff s left join staff_pay p on p.tenant_id = s.tenant_id and p.staff_id = s.id order by s.active desc, s.name`,
      )).rows.map((r) => ({ id: r.id, name: r.name, role: r.role, active: r.active, payType: r.pay_type, rate: r.rate, overtimeMultiplier: r.overtime_multiplier === null ? null : num(r.overtime_multiplier) })),
    );
  }

  async setPay(auth: ApiAuth, staffId: string, input: PayInput): Promise<void> {
    need(input.payType === 'HOURLY' || input.payType === 'MONTHLY', 'payType harus HOURLY atau MONTHLY');
    need(Number.isInteger(input.rate) && (input.rate as number) >= 0 && (input.rate as number) <= MAX_PAY, 'tarif harus bilangan bulat rupiah ≥ 0');
    const mult = input.overtimeMultiplier === undefined ? 1.5 : input.overtimeMultiplier;
    need(typeof mult === 'number' && mult >= 1 && mult <= 3 && Math.abs(Math.round(mult * 10) - mult * 10) < 1e-9, 'pengali lembur 1,0–3,0 (satu desimal)');
    await this.db.tenantTx(auth.tenantId, async (q) => {
      if ((await q.query('select 1 from staff where id = $1', [staffId])).rowCount === 0) throw new NotFoundException('staf tidak ditemukan');
      await q.query(
        `insert into staff_pay (tenant_id, staff_id, pay_type, rate, overtime_multiplier) values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, staff_id) do update set pay_type = excluded.pay_type, rate = excluded.rate, overtime_multiplier = excluded.overtime_multiplier`,
        [auth.tenantId, staffId, input.payType, input.rate, mult],
      );
      await this.audit(q, auth, 'staff.pay', { staffId, payType: input.payType, rate: input.rate });
    });
  }

  // ---------- absensi ----------

  /** Rentang kerja dari event dan koreksi manual untuk satu outlet; `pad` melebarkan jendela agar rentang yang melewati batas tetap utuh. */
  private async intervals(q: Queryable, outletId: string, fromMs: number, toMs: number, now: number): Promise<{ done: Interval[]; open: OpenInterval[]; manual: { id: number; staffId: string; start: number; end: number; reason: string; createdBy: string }[] }> {
    const rows = (await q.query<EventRow>(
      `select ${EVENT_COLUMNS} from event where outlet_id = $1 and type = 'attendance.clocked' and device_time_ms >= $2 and device_time_ms < $3 order by device_id, seq`,
      [outletId, fromMs - DAY_MS, toMs + DAY_MS],
    )).rows.map(rowToEvent);
    const { done, open } = buildIntervals(rows, now);
    const manual = (await q.query<{ id: string; staff_id: string; start_ms: number; end_ms: number; reason: string; created_by: string }>(
      'select id, staff_id, start_ms, end_ms, reason, created_by from attendance_adjust where outlet_id = $1 and voided_at is null and end_ms > $2 and start_ms < $3 order by start_ms', [outletId, fromMs, toMs],
    )).rows.map((m) => ({ id: num(m.id), staffId: m.staff_id, start: num(m.start_ms), end: num(m.end_ms), reason: m.reason, createdBy: m.created_by }));
    return {
      done: [...done, ...manual.map((m): Interval => ({ staffId: m.staffId, start: m.start, end: m.end, terminalId: null, manual: true }))].filter((i) => i.end > fromMs && i.start < toMs).sort((a, b) => a.start - b.start),
      open: open.filter((o) => o.start < toMs),
      manual,
    };
  }

  async attendance(auth: ApiAuth, outletId: string, params: { from?: string; to?: string; range?: string }, now: number) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const off = await this.outletOffset(q, outletId);
      const r = resolveRange(off, params, now);
      const fromMs = startOfLocalDay(r.from, off);
      const toMs = startOfLocalDay(r.to, off) + DAY_MS;
      const iv = await this.intervals(q, outletId, fromMs, toMs, now);
      const names = new Map((await q.query<{ id: string; name: string }>('select id, name from staff')).rows.map((s) => [s.id, s.name]));
      const rows = iv.done.map((i) => ({ staffId: i.staffId, name: names.get(i.staffId) ?? i.staffId, start: i.start, end: i.end, minutes: Math.round((i.end - i.start) / 60_000), terminalId: i.terminalId, manual: i.manual, inPhoto: i.inPhoto ?? null, outPhoto: i.outPhoto ?? null, inMissing: i.inMissing ?? null, outMissing: i.outMissing ?? null }));
      const open = iv.open.map((o) => ({ staffId: o.staffId, name: names.get(o.staffId) ?? o.staffId, start: o.start, terminalId: o.terminalId, stale: o.stale, inPhoto: o.inPhoto ?? null, inMissing: o.inMissing ?? null }));
      const byStaff = new Map<string, { staffId: string; name: string; days: Set<string>; minutes: number }>();
      for (const row of rows) {
        const s = byStaff.get(row.staffId) ?? { staffId: row.staffId, name: row.name, days: new Set<string>(), minutes: 0 };
        s.minutes += row.minutes;
        s.days.add(localDate(row.start, off));
        byStaff.set(row.staffId, s);
      }
      return {
        range: { from: r.from, to: r.to },
        rows, open, manual: iv.manual,
        summary: [...byStaff.values()].map((s) => ({ staffId: s.staffId, name: s.name, days: s.days.size, minutes: s.minutes })).sort((a, b) => a.name.localeCompare(b.name)),
      };
    });
  }

  /** Koreksi manual (mis. lupa absen pulang): menambah rentang kerja yang tidak boleh tumpang tindih dengan rentang lain staf itu. */
  async addManual(auth: ApiAuth, outletId: string, input: ManualInput, now: number): Promise<{ id: number }> {
    need(typeof input.staffId === 'string', 'staffId wajib');
    const start = typeof input.start === 'number' ? input.start : Number.NaN;
    const end = typeof input.end === 'number' ? input.end : Number.NaN;
    need(Number.isFinite(start) && Number.isFinite(end) && end > start, 'waktu mulai dan selesai tidak valid');
    need(end <= now, 'waktu selesai tidak boleh di masa depan');
    need(end - start <= MAX_OPEN_MS, 'satu rentang maksimal 16 jam');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    need(reason.length >= 3 && reason.length <= 140, 'alasan koreksi wajib (3–140 karakter)');
    return this.db.tenantTx(auth.tenantId, async (q) => {
      await this.outletOffset(q, outletId);
      if ((await q.query('select 1 from staff where id = $1', [input.staffId])).rowCount === 0) throw new NotFoundException('staf tidak ditemukan');
      const iv = await this.intervals(q, outletId, start - DAY_MS, end + DAY_MS, now);
      const clash = iv.done.find((i) => i.staffId === input.staffId && i.start < end && i.end > start) ?? iv.open.find((o) => o.staffId === input.staffId && o.start < end && !o.stale);
      if (clash) throw new ConflictException('tumpang tindih dengan rentang kerja staf ini yang sudah ada');
      const id = num((await q.query<{ id: string }>('insert into attendance_adjust (tenant_id, outlet_id, staff_id, start_ms, end_ms, reason, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id', [auth.tenantId, outletId, input.staffId, start, end, reason, auth.userId])).rows[0]!.id);
      await this.audit(q, auth, 'attendance.adjust', { id, outletId, staffId: input.staffId, minutes: Math.round((end - start) / 60_000), reason });
      return { id };
    });
  }

  async voidManual(auth: ApiAuth, outletId: string, id: number, reason: unknown): Promise<void> {
    const why = typeof reason === 'string' ? reason.trim() : '';
    need(why.length >= 3 && why.length <= 140, 'alasan pembatalan wajib (3–140 karakter)');
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const a = (await q.query<{ voided_at: string | null }>('select voided_at from attendance_adjust where id = $1 and outlet_id = $2', [id, outletId])).rows[0];
      if (!a) throw new NotFoundException('koreksi tidak ditemukan');
      if (a.voided_at) throw new ConflictException('koreksi ini sudah dibatalkan');
      await q.query('update attendance_adjust set voided_at = now(), void_reason = $2 where id = $1', [id, why]);
      await this.audit(q, auth, 'attendance.adjust.void', { id, outletId, reason: why });
    });
  }

  // ---------- penggajian ----------

  async createRun(auth: ApiAuth, outletId: string, input: RunInput, now: number): Promise<{ id: number; warnings: string[] }> {
    const hours = input.dailyRegularHours === undefined ? 8 : input.dailyRegularHours;
    need(typeof hours === 'number' && hours >= 1 && hours <= 24 && Number.isInteger(hours * 4), 'jam kerja reguler per hari 1–24 (kelipatan 15 menit)');
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const off = await this.outletOffset(q, outletId);
      const r = resolveRange(off, { from: input.from as string | undefined, to: input.to as string | undefined }, now);
      const fromMs = startOfLocalDay(r.from, off);
      const toMs = startOfLocalDay(r.to, off) + DAY_MS;
      const overlap = (await q.query<{ id: string }>("select id from payroll_run where outlet_id = $1 and status <> 'CANCELED' and period_start <= $3 and period_end >= $2", [outletId, r.from, r.to])).rows[0];
      if (overlap) throw new ConflictException(`periode ini tumpang tindih dengan penggajian #${overlap.id}`);
      const iv = await this.intervals(q, outletId, fromMs, toMs, now);
      const staff = (await q.query<{ id: string; name: string; pinned: boolean; pay_type: 'HOURLY' | 'MONTHLY'; rate: number; overtime_multiplier: string }>(
        `select s.id, s.name, s.outlet_ids is not null as pinned, p.pay_type, p.rate, p.overtime_multiplier from staff s join staff_pay p on p.tenant_id = s.tenant_id and p.staff_id = s.id
         where s.active and (s.outlet_ids is null or jsonb_exists(s.outlet_ids, $1)) order by s.name`, [outletId],
      )).rows;
      need(staff.length > 0, 'belum ada staf dengan tarif gaji untuk outlet ini (atur di tab Tarif)');
      const runId = num((await q.query<{ id: string }>("insert into payroll_run (tenant_id, outlet_id, period_start, period_end, status, daily_regular_minutes, created_by) values ($1, $2, $3, $4, 'DRAFT', $5, $6) returning id", [auth.tenantId, outletId, r.from, r.to, Math.round((hours as number) * 60), auth.userId])).rows[0]!.id);
      const warnings: string[] = [];
      for (const st of staff) {
        const mine = iv.done.filter((i) => i.staffId === st.id).map((i) => ({ start: Math.max(i.start, fromMs), end: Math.min(i.end, toMs) })).filter((i) => i.end > i.start);
        const rule: PayRule = { payType: st.pay_type, rate: st.rate, overtimeMultiplier: num(st.overtime_multiplier) };
        const p = computePay(mine, rule, off, Math.round((hours as number) * 60));
        // Absen masuk yang tidak pernah ditutup dan belum dikoreksi: jamnya tidak dihitung, jadi pemilik perlu tahu sebelum membayar.
        const openStale = iv.open.find((o) => o.staffId === st.id && o.stale);
        const corrected = openStale && iv.manual.some((m) => m.staffId === st.id && m.start >= openStale.start - 3_600_000 && m.end <= openStale.start + MAX_OPEN_MS);
        if (openStale && !corrected) warnings.push(`${st.name} punya absen masuk yang tidak pernah ditutup (lupa absen pulang); jam itu tidak dihitung. Koreksi di tab Absensi lalu buat ulang.`);
        if (p.regularMinutes + p.overtimeMinutes === 0) { // tidak bekerja di outlet ini pada periode ini
          if (st.pay_type === 'MONTHLY' && st.pinned) warnings.push(`${st.name} (gaji bulanan) tidak punya absensi di outlet ini pada periode; tidak dimasukkan. Koreksi absen bila ia sebenarnya bekerja.`);
          continue;
        }
        if (st.pay_type === 'MONTHLY') {
          // Gaji tetap hanya boleh dibayar sekali per periode: jangan dobel bila outlet lain sudah memuatnya.
          const dup = (await q.query<{ id: string; outlet_id: string }>(
            "select r.id, r.outlet_id from payroll_run r join payroll_line l on l.run_id = r.id where l.staff_id = $1 and l.pay_type = 'MONTHLY' and r.status <> 'CANCELED' and r.id <> $2 and r.period_start <= $4 and r.period_end >= $3 limit 1",
            [st.id, runId, r.from, r.to],
          )).rows[0];
          if (dup) { warnings.push(`${st.name} (gaji bulanan) sudah dimuat di penggajian #${dup.id} (${dup.outlet_id}) untuk periode yang tumpang tindih; tidak dimasukkan lagi.`); continue; }
        }
        await q.query(
          `insert into payroll_line (tenant_id, run_id, staff_id, staff_name, pay_type, rate, regular_minutes, overtime_minutes, base, overtime_pay, net)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [auth.tenantId, runId, st.id, st.name, st.pay_type, st.rate, p.regularMinutes, p.overtimeMinutes, p.base, p.overtimePay, netPay(p.base, p.overtimePay, 0, 0)],
        );
      }
      need((await q.query('select 1 from payroll_line where run_id = $1', [runId])).rowCount > 0, 'tidak ada jam kerja atau gaji tetap pada periode ini');
      await this.audit(q, auth, 'payroll.create', { runId, outletId, from: r.from, to: r.to });
      return { id: runId, warnings };
    });
  }

  private async getRun(q: Queryable, id: number) {
    const r = (await q.query<{ id: string; outlet_id: string; period_start: string; period_end: string; status: RunStatus; daily_regular_minutes: number; created_by: string; finalized_by: string | null; paid_date: string | null; pay_method: string | null; cancel_reason: string | null }>(
      'select id, outlet_id, period_start, period_end, status, daily_regular_minutes, created_by, finalized_by, paid_date, pay_method, cancel_reason from payroll_run where id = $1 for update', [id],
    )).rows[0];
    if (!r) throw new NotFoundException('penggajian tidak ditemukan');
    return r;
  }

  async updateLine(auth: ApiAuth, runId: number, staffId: string, input: LineInput): Promise<void> {
    for (const k of ['allowance', 'deduction'] as const) {
      const v = input[k];
      need(v === undefined || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_PAY), `${k === 'allowance' ? 'tunjangan' : 'potongan'} harus bilangan bulat rupiah ≥ 0`);
    }
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 140) : null;
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const run = await this.getRun(q, runId);
      if (run.status !== 'DRAFT') throw new ConflictException('hanya penggajian draf yang bisa diubah');
      const l = (await q.query<{ base: string; overtime_pay: string; allowance: string; deduction: string }>('select base, overtime_pay, allowance, deduction from payroll_line where run_id = $1 and staff_id = $2', [runId, staffId])).rows[0];
      if (!l) throw new NotFoundException('staf tidak ada di penggajian ini');
      const allowance = (input.allowance as number | undefined) ?? num(l.allowance);
      const deduction = (input.deduction as number | undefined) ?? num(l.deduction);
      await q.query('update payroll_line set allowance = $3, deduction = $4, net = $5, note = coalesce($6, note) where run_id = $1 and staff_id = $2', [runId, staffId, allowance, deduction, netPay(num(l.base), num(l.overtime_pay), allowance, deduction), note]);
      await this.audit(q, auth, 'payroll.line', { runId, staffId, allowance, deduction });
    });
  }

  async finalize(auth: ApiAuth, runId: number): Promise<void> {
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const run = await this.getRun(q, runId);
      if (run.status !== 'DRAFT') throw new ConflictException('hanya penggajian draf yang bisa difinalkan');
      await q.query("update payroll_run set status = 'FINAL', finalized_by = $2, finalized_at = now() where id = $1", [runId, auth.userId]);
      await this.audit(q, auth, 'payroll.finalize', { runId });
    });
  }

  /** Mencatat pembayaran gaji: jurnal Dr Beban Gaji, Cr Kas/Bank sebesar total gaji bersih pada tanggal bayar. */
  async pay(auth: ApiAuth, runId: number, input: { date?: unknown; method?: unknown }, now: number): Promise<{ total: number }> {
    need(input.method === 'TUNAI' || input.method === 'TRANSFER', 'metode harus TUNAI atau TRANSFER');
    need(typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date) && !Number.isNaN(Date.parse(`${input.date}T00:00:00Z`)), 'tanggal harus YYYY-MM-DD');
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const run = await this.getRun(q, runId);
      if (run.status !== 'FINAL') throw new ConflictException(run.status === 'DRAFT' ? 'finalkan penggajian dulu' : 'penggajian ini sudah dibayar atau dibatalkan');
      const off = await this.outletOffset(q, run.outlet_id);
      need((input.date as string) <= localDate(now, off), 'tanggal pembayaran tidak boleh di masa depan');
      need((input.date as string) >= run.period_end, 'gaji dibayar setelah periodenya berakhir');
      const total = num((await q.query<{ t: string }>('select coalesce(sum(net), 0) as t from payroll_line where run_id = $1', [runId])).rows[0]!.t);
      await q.query("update payroll_run set status = 'PAID', paid_date = $2, pay_method = $3 where id = $1", [runId, input.date, input.method]);
      await this.audit(q, auth, 'payroll.pay', { runId, total, method: input.method, date: input.date });
      return { total };
    });
  }

  async cancel(auth: ApiAuth, runId: number, reason: unknown): Promise<void> {
    const why = typeof reason === 'string' ? reason.trim() : '';
    need(why.length >= 3 && why.length <= 140, 'alasan pembatalan wajib (3–140 karakter)');
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const run = await this.getRun(q, runId);
      if (run.status !== 'DRAFT' && run.status !== 'FINAL') throw new ConflictException('penggajian yang sudah dibayar tidak bisa dibatalkan');
      await q.query("update payroll_run set status = 'CANCELED', cancel_reason = $2 where id = $1", [runId, why]);
      await this.audit(q, auth, 'payroll.cancel', { runId, reason: why });
    });
  }

  async listRuns(auth: ApiAuth, outletId?: string) {
    return this.db.tenantTx(auth.tenantId, async (q) =>
      (await q.query<{ id: string; outlet_id: string; period_start: string; period_end: string; status: RunStatus; paid_date: string | null; created_by: string; total: string; staff: string }>(
        `select r.id, r.outlet_id, r.period_start, r.period_end, r.status, r.paid_date, r.created_by,
                coalesce((select sum(net) from payroll_line l where l.run_id = r.id), 0) as total, (select count(*) from payroll_line l where l.run_id = r.id) as staff
         from payroll_run r where ($1::text is null or r.outlet_id = $1) order by r.id desc limit 100`, [outletId ?? null],
      )).rows.map((r) => ({ id: num(r.id), outletId: r.outlet_id, from: r.period_start, to: r.period_end, status: r.status, paidDate: r.paid_date, createdBy: r.created_by, total: num(r.total), staff: num(r.staff) })),
    );
  }

  async detail(auth: ApiAuth, runId: number) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const r = (await q.query<{ id: string; outlet_id: string; period_start: string; period_end: string; status: RunStatus; daily_regular_minutes: number; created_by: string; finalized_by: string | null; paid_date: string | null; pay_method: string | null; cancel_reason: string | null }>(
        'select id, outlet_id, period_start, period_end, status, daily_regular_minutes, created_by, finalized_by, paid_date, pay_method, cancel_reason from payroll_run where id = $1', [runId],
      )).rows[0];
      if (!r) throw new NotFoundException('penggajian tidak ditemukan');
      const lines = (await q.query<{ staff_id: string; staff_name: string; pay_type: string; rate: number; regular_minutes: number; overtime_minutes: number; base: string; overtime_pay: string; allowance: string; deduction: string; net: string; note: string | null }>(
        'select staff_id, staff_name, pay_type, rate, regular_minutes, overtime_minutes, base, overtime_pay, allowance, deduction, net, note from payroll_line where run_id = $1 order by staff_name', [runId],
      )).rows.map((l) => ({ staffId: l.staff_id, name: l.staff_name, payType: l.pay_type, rate: l.rate, regularMinutes: l.regular_minutes, overtimeMinutes: l.overtime_minutes, base: num(l.base), overtimePay: num(l.overtime_pay), allowance: num(l.allowance), deduction: num(l.deduction), net: num(l.net), note: l.note }));
      return { id: num(r.id), outletId: r.outlet_id, from: r.period_start, to: r.period_end, status: r.status, dailyRegularMinutes: r.daily_regular_minutes, createdBy: r.created_by, finalizedBy: r.finalized_by, paidDate: r.paid_date, payMethod: r.pay_method, cancelReason: r.cancel_reason, lines, total: lines.reduce((s, l) => s + l.net, 0) };
    });
  }

  /** CSV slip gaji per staf untuk satu penggajian. Tercatat di audit karena memuat data gaji. */
  async exportCsv(auth: ApiAuth, runId: number): Promise<{ filename: string; csv: string }> {
    const d = await this.detail(auth, runId);
    const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
    const csv = toCsv({
      header: ['Staf', 'Jenis', 'Tarif', 'Jam reguler', 'Jam lembur', 'Gaji pokok', 'Lembur', 'Tunjangan', 'Potongan', 'Gaji bersih', 'Catatan'],
      rows: d.lines.map((l) => [l.name, l.payType === 'HOURLY' ? 'Per jam' : 'Bulanan', l.rate, hm(l.regularMinutes), hm(l.overtimeMinutes), l.base, l.overtimePay, l.allowance, l.deduction, l.net, l.note ?? '']),
    });
    await this.db.tenantTx(auth.tenantId, (q) => this.audit(q, auth, 'export.payroll', { runId }));
    return { filename: `${d.outletId}-gaji-${d.from}_${d.to}.csv`, csv };
  }
}

