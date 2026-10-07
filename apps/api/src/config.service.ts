import { pbkdf2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ApiAuth, DeviceAuth } from './auth';
import { Database } from './db/database';
import type { Queryable } from './db/driver';
import { DEFAULT_SHADOW_DAYS, shadowState } from './shadow';

const pbkdf2Async = promisify(pbkdf2);

export const PIN_ITERATIONS = 310_000;
export const ROLES = ['CASHIER', 'SUPERVISOR', 'MANAGER', 'OWNER'] as const;
export type StaffRole = (typeof ROLES)[number];

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** PIN 4–6 digit; menolak pola mudah ditebak (semua sama, berurutan naik atau turun). */
export function validatePin(pin: unknown): string {
  if (typeof pin !== 'string' || !/^[0-9]{4,6}$/.test(pin)) throw new BadRequestException('PIN harus 4–6 digit angka');
  if (/^(\d)\1+$/.test(pin)) throw new BadRequestException('PIN terlalu mudah ditebak (angka sama semua)');
  const d = [...pin].map(Number);
  const step = d.every((x, i) => i === 0 || x - d[i - 1]! === 1) || d.every((x, i) => i === 0 || d[i - 1]! - x === 1);
  if (step) throw new BadRequestException('PIN terlalu mudah ditebak (angka berurutan)');
  return pin;
}

const need = (cond: boolean, msg: string) => {
  if (!cond) throw new BadRequestException(msg);
};

export interface StaffInput {
  id?: string;
  name?: string;
  role?: string;
  pin?: string;
  outletIds?: string[] | null;
  active?: boolean;
}

export interface MenuInput {
  id?: string;
  name?: string;
  price?: number;
  category?: string;
  sort?: number;
  outletId?: string | null;
  active?: boolean;
}

export interface SettingsInput {
  merchantName?: string;
  taxPercent?: number;
  edcs?: { tid: string; bank: string; label: string }[];
  policy?: {
    secondApprovalAbove?: number;
    manualDiscountMaxPercent?: number;
    manualDiscountMaxAmount?: number;
    employeeMealQuota?: number;
  } | null;
  cctvRetentionDays?: number;
  cctvClockOffsetSec?: number;
  /** Lama mode shadow (hari, 0 = nonaktif). Mengubah hanya lama; mulai ulang dari sekarang dengan `shadowRestart`. */
  shadowDays?: number;
  /** Memulai hitungan shadow dari sekarang (untuk mengaktifkan kembali). Perlu `shadowDays` > 0. */
  shadowRestart?: boolean;
}

export interface OutletInput {
  name?: string;
  terminals?: string[];
}

const MAX_OUTLETS_PER_TENANT = 100;
const TERMINAL_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

function outletName(v: unknown): string {
  const n = typeof v === 'string' ? v.trim() : '';
  need(n.length >= 1 && n.length <= 80, 'nama outlet wajib diisi (maks. 80 karakter)');
  return n;
}

function terminalList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  need(Array.isArray(v) && v.length <= 50, 'terminals harus berupa daftar (maks. 50)');
  const out = (v as unknown[]).map((t) => {
    need(typeof t === 'string' && TERMINAL_RE.test(t), 'ID terminal hanya huruf kecil, angka, - atau _ (2–40 karakter)');
    return t as string;
  });
  need(new Set(out).size === out.length, 'ID terminal tidak boleh kembar');
  return out;
}

export interface DeviceConfig {
  version: string;
  serverTime: number;
  deviceId: string;
  outlet: {
    id: string;
    merchantName: string;
    taxPercent: number;
    edcs: { tid: string; bank: string; label: string }[];
    policy: Record<string, number> | null;
  };
  staff: { id: string; name: string; role: StaffRole; salt: string; hash: string; iterations: number }[];
  menu: { id: string; name: string; price: number; category: string }[];
}

@Injectable()
export class ConfigService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject('PIN_ITERATIONS') private readonly iterations: number,
  ) {}

  private audit(q: Queryable, auth: ApiAuth, action: string, detail: object) {
    return q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [
      auth.tenantId, auth.userId, action, JSON.stringify(detail),
    ]);
  }

  private async hashPin(pin: string) {
    const salt = randomBytes(16);
    const hash = await pbkdf2Async(pin, salt, this.iterations, 32, 'sha256');
    return { salt: salt.toString('hex'), hash: hash.toString('hex'), iterations: this.iterations };
  }

  // ---------- staf ----------

  listStaff(auth: ApiAuth) {
    return this.db.tenantTx(auth.tenantId, async (q) =>
      (await q.query('select id, name, role, outlet_ids, active, updated_at from staff order by name')).rows,
    );
  }

  async createStaff(auth: ApiAuth, input: StaffInput): Promise<void> {
    need(typeof input.id === 'string' && ID.test(input.id), 'id: huruf kecil, angka, - atau _ (maks. 32)');
    need(typeof input.name === 'string' && input.name.trim().length > 0 && input.name.length <= 60, 'nama wajib (maks. 60)');
    need((ROLES as readonly string[]).includes(input.role ?? ''), `role harus salah satu dari ${ROLES.join(', ')}`);
    const pin = validatePin(input.pin);
    const h = await this.hashPin(pin);
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const exists = (await q.query('select 1 from staff where id = $1', [input.id])).rowCount > 0;
      if (exists) throw new BadRequestException('id staf sudah dipakai');
      await q.query(
        `insert into staff (tenant_id, id, name, role, pin_salt, pin_hash, pin_iterations, outlet_ids)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [auth.tenantId, input.id, input.name!.trim(), input.role, h.salt, h.hash, h.iterations, input.outletIds ? JSON.stringify(input.outletIds) : null],
      );
      await this.audit(q, auth, 'staff.create', { id: input.id, role: input.role });
    });
  }

  async updateStaff(auth: ApiAuth, id: string, input: StaffInput): Promise<void> {
    if (input.role !== undefined) need((ROLES as readonly string[]).includes(input.role), `role harus salah satu dari ${ROLES.join(', ')}`);
    if (input.name !== undefined) need(input.name.trim().length > 0 && input.name.length <= 60, 'nama tidak valid');
    const h = input.pin !== undefined ? await this.hashPin(validatePin(input.pin)) : null;
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await q.query(
        `update staff set name = coalesce($2, name), role = coalesce($3, role),
                pin_salt = coalesce($4, pin_salt), pin_hash = coalesce($5, pin_hash), pin_iterations = coalesce($6, pin_iterations),
                outlet_ids = case when $7::boolean then $8::jsonb else outlet_ids end,
                active = coalesce($9, active), updated_at = now()
         where id = $1`,
        [
          id, input.name?.trim() ?? null, input.role ?? null, h?.salt ?? null, h?.hash ?? null, h?.iterations ?? null,
          input.outletIds !== undefined, input.outletIds ? JSON.stringify(input.outletIds) : null, input.active ?? null,
        ],
      );
      if (r.rowCount === 0) throw new NotFoundException('staf tidak ditemukan');
      await this.audit(q, auth, 'staff.update', {
        id, fields: Object.keys(input).filter((k) => k !== 'pin'), pinChanged: input.pin !== undefined,
      });
    });
  }

  // ---------- menu ----------

  listMenu(auth: ApiAuth) {
    return this.db.tenantTx(auth.tenantId, async (q) =>
      (await q.query('select id, name, price, category, sort, outlet_id, active, updated_at from menu_item order by category, sort, name')).rows,
    );
  }

  private checkMenu(i: MenuInput, partial: boolean) {
    if (!partial || i.name !== undefined) need(typeof i.name === 'string' && i.name.trim().length > 0 && i.name.length <= 60, 'nama menu wajib (maks. 60)');
    if (!partial || i.price !== undefined) need(Number.isInteger(i.price) && i.price! >= 0 && i.price! <= 100_000_000, 'harga harus bilangan bulat rupiah ≥ 0');
    if (!partial || i.category !== undefined) need(typeof i.category === 'string' && i.category.trim().length > 0 && i.category.length <= 30, 'kategori wajib (maks. 30)');
  }

  async createMenu(auth: ApiAuth, input: MenuInput): Promise<void> {
    need(typeof input.id === 'string' && ID.test(input.id), 'id: huruf kecil, angka, - atau _ (maks. 32)');
    this.checkMenu(input, false);
    await this.db.tenantTx(auth.tenantId, async (q) => {
      if ((await q.query('select 1 from menu_item where id = $1', [input.id])).rowCount > 0) throw new BadRequestException('id menu sudah dipakai');
      if (input.outletId && (await q.query('select 1 from outlet where id = $1', [input.outletId])).rowCount === 0) throw new NotFoundException('outlet tidak ditemukan');
      await q.query(
        'insert into menu_item (tenant_id, id, outlet_id, name, price, category, sort) values ($1, $2, $3, $4, $5, $6, $7)',
        [auth.tenantId, input.id, input.outletId ?? null, input.name!.trim(), input.price, input.category!.trim(), input.sort ?? 0],
      );
      await this.audit(q, auth, 'menu.create', { id: input.id, price: input.price });
    });
  }

  async updateMenu(auth: ApiAuth, id: string, input: MenuInput): Promise<void> {
    this.checkMenu(input, true);
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const before = (await q.query<{ price: number }>('select price from menu_item where id = $1', [id])).rows[0];
      if (!before) throw new NotFoundException('menu tidak ditemukan');
      await q.query(
        `update menu_item set name = coalesce($2, name), price = coalesce($3, price), category = coalesce($4, category),
                sort = coalesce($5, sort), active = coalesce($6, active), updated_at = now() where id = $1`,
        [id, input.name?.trim() ?? null, input.price ?? null, input.category?.trim() ?? null, input.sort ?? null, input.active ?? null],
      );
      await this.audit(q, auth, 'menu.update', { id, ...(input.price !== undefined ? { priceFrom: before.price, priceTo: input.price } : {}), fields: Object.keys(input) });
    });
  }

  // ---------- pengaturan outlet ----------

  async getSettings(auth: ApiAuth, outletId: string, now = Date.now()) {
    const row = await this.db.tenantTx(auth.tenantId, async (q) =>
      (await q.query<{ shadow_days: number; shadow_started_ms: number | null }>('select id, name, terminals, merchant_name, tax_percent, edcs, policy, cctv_retention_days, cctv_clock_offset_sec, shadow_days, shadow_started_ms from outlet where id = $1', [outletId])).rows[0],
    );
    if (!row) throw new NotFoundException('outlet tidak ditemukan');
    const { shadow_started_ms, ...rest } = row;
    return { ...rest, shadow: shadowState(row.shadow_days, shadow_started_ms, now) };
  }

  async updateSettings(auth: ApiAuth, outletId: string, s: SettingsInput, now = Date.now()): Promise<void> {
    if (s.merchantName !== undefined) need(s.merchantName.trim().length > 0 && s.merchantName.length <= 80, 'nama merchant wajib (maks. 80)');
    if (s.taxPercent !== undefined) need(Number.isInteger(s.taxPercent) && s.taxPercent >= 0 && s.taxPercent <= 100, 'taxPercent 0–100');
    if (s.edcs !== undefined) {
      need(Array.isArray(s.edcs) && s.edcs.length <= 10, 'edcs maksimal 10');
      for (const e of s.edcs) need(/^[0-9]{6,12}$/.test(e.tid) && !!e.bank?.trim() && !!e.label?.trim(), 'setiap EDC perlu tid (6–12 digit), bank, dan label');
      need(new Set(s.edcs.map((e) => e.tid)).size === s.edcs.length, 'TID EDC tidak boleh ganda');
    }
    if (s.policy) {
      for (const [k, v] of Object.entries(s.policy)) {
        need(['secondApprovalAbove', 'manualDiscountMaxPercent', 'manualDiscountMaxAmount', 'employeeMealQuota'].includes(k), `kebijakan tidak dikenal: ${k}`);
        if (k === 'employeeMealQuota') need(Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10, 'employeeMealQuota 0–10 (0 = setiap makan karyawan perlu persetujuan)');
        else need(Number.isInteger(v) && (v as number) > 0, `${k} harus bilangan bulat positif`);
      }
    }
    if (s.cctvRetentionDays !== undefined) need(Number.isInteger(s.cctvRetentionDays) && s.cctvRetentionDays >= 1 && s.cctvRetentionDays <= 365, 'cctvRetentionDays 1–365');
    if (s.shadowDays !== undefined) need(Number.isInteger(s.shadowDays) && s.shadowDays >= 0 && s.shadowDays <= 60, 'shadowDays 0–60 (0 = nonaktif)');
    if (s.shadowRestart !== undefined) need(typeof s.shadowRestart === 'boolean', 'shadowRestart harus true atau false');
    if (s.shadowRestart) need(s.shadowDays !== undefined && s.shadowDays > 0, 'shadowRestart memerlukan shadowDays lebih dari 0');
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await q.query(
        `update outlet set merchant_name = coalesce($2, merchant_name), tax_percent = coalesce($3, tax_percent),
                edcs = coalesce($4::jsonb, edcs), policy = case when $5::boolean then $6::jsonb else policy end,
                cctv_retention_days = coalesce($7, cctv_retention_days), cctv_clock_offset_sec = coalesce($8, cctv_clock_offset_sec),
                shadow_days = coalesce($9, shadow_days),
                shadow_started_ms = case when $10::boolean then $11::float8 else shadow_started_ms end
         where id = $1`,
        [
          outletId, s.merchantName?.trim() ?? null, s.taxPercent ?? null, s.edcs ? JSON.stringify(s.edcs) : null,
          s.policy !== undefined, s.policy ? JSON.stringify(s.policy) : null, s.cctvRetentionDays ?? null, s.cctvClockOffsetSec ?? null,
          s.shadowDays ?? null, s.shadowRestart === true, now,
        ],
      );
      if (r.rowCount === 0) throw new NotFoundException('outlet tidak ditemukan');
      await this.audit(q, auth, 'outlet.settings', {
        outletId, fields: Object.keys(s),
        ...(s.shadowDays !== undefined ? { shadowDays: s.shadowDays, shadowRestart: s.shadowRestart === true } : {}),
      });
    });
  }

  // ---------- manajemen outlet oleh owner ----------

  /**
   * Owner membuat outlet baru. ID dibuat server dari ID tenant + nama (unik di seluruh platform; dipakai di event dan alamat),
   * sehingga owner tidak perlu memikirkannya dan tidak bisa menabrak tenant lain.
   */
  async createOutlet(auth: ApiAuth, input: OutletInput): Promise<{ id: string; name: string; terminals: string[] }> {
    const name = outletName(input.name);
    const terminals = terminalList(input.terminals);
    const count = (await this.db.tenantTx(auth.tenantId, async (q) => (await q.query<{ n: number }>('select count(*)::int as n from outlet')).rows[0]!.n));
    need(count < MAX_OUTLETS_PER_TENANT, `jumlah outlet maksimal ${MAX_OUTLETS_PER_TENANT}`);

    const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'outlet';
    // Awalan tenant menjaga ID unik; bila nama sudah diawali ID tenant ("Palmerah Barat" di tenant "palmerah"), tidak diulang.
    const base = (slug === auth.tenantId || slug.startsWith(`${auth.tenantId}-`) ? slug : `${auth.tenantId}-${slug}`).slice(0, 36).replace(/-+$/, '');
    const candidates = [base, ...Array.from({ length: 20 }, (_, i) => `${base}-${i + 2}`)];
    // ID outlet unik global: periksa sebagai pemilik skema, karena RLS hanya memperlihatkan outlet tenant ini.
    const taken = new Set((await this.db.admin.query<{ id: string }>('select id from outlet where id = any($1::text[])', [candidates])).rows.map((r) => r.id));
    const id = candidates.find((c) => !taken.has(c));
    if (!id) throw new ConflictException('tidak bisa membuat ID outlet unik; ubah nama outlet');

    try {
      await this.db.tenantTx(auth.tenantId, async (q) => {
        await q.query('insert into outlet (id, tenant_id, name, terminals, shadow_days) values ($1, $2, $3, $4::jsonb, $5)', [id, auth.tenantId, name, JSON.stringify(terminals), DEFAULT_SHADOW_DAYS]);
        await this.audit(q, auth, 'outlet.create', { outletId: id, name, terminals });
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('ID outlet bentrok; coba lagi');
      throw e;
    }
    return { id, name, terminals };
  }

  /**
   * Mengubah nama dan/atau daftar terminal. Terminal yang terdaftar tetapi tidak pernah mengirim data membuat mesin aturan menunggu
   * (jendela evaluasi menunggu semua terminal), jadi daftarnya harus sesuai dengan terminal yang benar-benar dipakai.
   */
  async updateOutlet(auth: ApiAuth, outletId: string, input: OutletInput): Promise<void> {
    need(input.name !== undefined || input.terminals !== undefined, 'tidak ada yang diubah');
    const name = input.name === undefined ? null : outletName(input.name);
    const terminals = input.terminals === undefined ? null : terminalList(input.terminals);
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await q.query('update outlet set name = coalesce($2, name), terminals = coalesce($3::jsonb, terminals) where id = $1', [
        outletId, name, terminals ? JSON.stringify(terminals) : null,
      ]);
      if (r.rowCount === 0) throw new NotFoundException('outlet tidak ditemukan');
      await this.audit(q, auth, 'outlet.update', { outletId, ...(name ? { name } : {}), ...(terminals ? { terminals } : {}) });
    });
  }

  // ---------- konfigurasi untuk terminal ----------

  /**
   * Konfigurasi yang diunduh terminal POS: pengaturan outlet, staf aktif (hash PIN berasin, bukan PIN), dan menu aktif.
   * `version` adalah sidik jari isi, sehingga terminal tahu apakah ada perubahan tanpa mengunduh ulang.
   */
  async deviceConfig(device: DeviceAuth): Promise<DeviceConfig> {
    return this.db.tenantTx(device.tenantId, async (q) => {
      const o = (
        await q.query<{ id: string; name: string; merchant_name: string | null; tax_percent: number; edcs: DeviceConfig['outlet']['edcs']; policy: Record<string, number> | null }>(
          'select id, name, merchant_name, tax_percent, edcs, policy from outlet where id = $1',
          [device.outletId],
        )
      ).rows[0];
      if (!o) throw new NotFoundException('outlet tidak ditemukan');
      const staff = (
        await q.query<{ id: string; name: string; role: StaffRole; pin_salt: string; pin_hash: string; pin_iterations: number }>(
          `select id, name, role, pin_salt, pin_hash, pin_iterations from staff
           where active and (outlet_ids is null or jsonb_exists(outlet_ids, $1)) order by id`,
          [device.outletId],
        )
      ).rows;
      const menu = (
        await q.query<DeviceConfig['menu'][number]>(
          `select id, name, price, category from menu_item
           where active and (outlet_id is null or outlet_id = $1) order by category, sort, name`,
          [device.outletId],
        )
      ).rows;
      const body = {
        outlet: { id: o.id, merchantName: o.merchant_name ?? o.name, taxPercent: o.tax_percent, edcs: o.edcs, policy: o.policy },
        staff: staff.map((s) => ({ id: s.id, name: s.name, role: s.role, salt: s.pin_salt, hash: s.pin_hash, iterations: s.pin_iterations })),
        menu,
      };
      const version = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
      return { version, serverTime: Date.now(), deviceId: device.deviceId, ...body };
    });
  }
}
