import { pbkdf2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ApiAuth, DeviceAuth } from './auth';
import { Database } from './db/database';
import type { Queryable } from './db/driver';
import { checkModifierGroups, checkPromo, type ModifierGroup, type Promo } from '@pos/order';
import { DEFAULT_SHADOW_DAYS, shadowState } from './shadow';
import { parseMenuCsv, type ImportError } from './menu-import';

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

/** Foto menu kecil (dikecilkan di dashboard); batas keras di server. */
export const MENU_IMAGE_MAX_BYTES = 150 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function imageMagicOk(type: string, b: Buffer): boolean {
  if (type === 'image/jpeg') return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === 'image/png') return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
}

export interface MenuInput {
  id?: string;
  name?: string;
  price?: number;
  category?: string;
  sort?: number;
  outletId?: string | null;
  active?: boolean;
  /** Varian dan tambahan; `[]` menghapus semuanya. */
  modifierGroups?: ModifierGroup[];
}

export interface SettingsInput {
  merchantName?: string;
  taxPercent?: number;
  /** Service charge 0–30%, pajak atas service, dan pembulatan total (0, 100, 500, 1000). */
  serviceChargePercent?: number;
  taxOnService?: boolean;
  roundingUnit?: number;
  edcs?: { tid: string; bank: string; label: string }[];
  /**
   * Loyalty: `rupiahPerPoint` belanja Rp sekian = 1 poin (0 = loyalty mati), `pointValue` nilai Rp per poin saat ditukar (0 = tidak bisa ditukar),
   * `maxRedeemPercent` batas potongan dari subtotal (1–100).
   */
  loyalty?: { rupiahPerPoint: number; pointValue: number; maxRedeemPercent: number };
  /** Denah meja; `[]` menghapusnya (kasir kembali mengetik nomor meja bebas). */
  tables?: { no: string; area: string; seats: number }[];
  policy?: {
    secondApprovalAbove?: number;
    manualDiscountMaxPercent?: number;
    manualDiscountMaxAmount?: number;
    employeeMealQuota?: number;
    holdBillMinutes?: number;
  } | null;
  cctvRetentionDays?: number;
  cctvClockOffsetSec?: number;
  /** Lama mode shadow (hari, 0 = nonaktif). Mengubah hanya lama; mulai ulang dari sekarang dengan `shadowRestart`. */
  shadowDays?: number;
  /** Memulai hitungan shadow dari sekarang (untuk mengaktifkan kembali). Perlu `shadowDays` > 0. */
  shadowRestart?: boolean;
}

/** Promo apa adanya dari tabel; kolom kosong dihilangkan agar bentuknya sama dengan `Promo` di terminal. */
interface PromoRow {
  id: string; outlet_id: string | null; name: string; kind: 'PERCENT' | 'AMOUNT'; value: number; min_subtotal: number | null; max_discount: number | null;
  days: number[] | null; start_date: string | null; end_date: string | null; start_hour: number | null; end_hour: number | null; active: boolean;
}
const PROMO_COLUMNS = 'id, outlet_id, name, kind, value, min_subtotal, max_discount, days, start_date, end_date, start_hour, end_hour, active';
const rowToPromo = (r: PromoRow): Promo => ({
  id: r.id, name: r.name, kind: r.kind, value: r.value,
  ...(r.min_subtotal !== null ? { minSubtotal: r.min_subtotal } : {}), ...(r.max_discount !== null ? { maxDiscount: r.max_discount } : {}),
  ...(r.days && r.days.length > 0 ? { days: r.days } : {}), ...(r.start_date ? { startDate: r.start_date } : {}), ...(r.end_date ? { endDate: r.end_date } : {}),
  ...(r.start_hour !== null && r.end_hour !== null ? { startHour: r.start_hour, endHour: r.end_hour } : {}),
});

export interface PromoInput extends Partial<Omit<Promo, 'minSubtotal' | 'maxDiscount' | 'days' | 'startDate' | 'endDate' | 'startHour' | 'endHour'>> {
  /** null = hapus batasan; tidak ada = tidak diubah. */
  minSubtotal?: number | null;
  maxDiscount?: number | null;
  days?: number[] | null;
  startDate?: string | null;
  endDate?: string | null;
  startHour?: number | null;
  endHour?: number | null;
  outletId?: string | null;
  active?: boolean;
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
  /** Jenis perangkat: layar dapur tidak menerima staf dan menu. */
  deviceKind: DeviceAuth['deviceKind'];
  /** Awal alamat struk digital (sudah berakhiran "/r/"); QR di layar customer = ini + token. Kosong = pakai alamat API terminal. */
  receiptBaseUrl?: string;
  outlet: {
    id: string;
    merchantName: string;
    taxPercent: number;
    serviceChargePercent?: number;
    taxOnService?: boolean;
    roundingUnit?: number;
    edcs: { tid: string; bank: string; label: string }[];
    /** Hanya bila loyalty aktif di outlet ini. */
    loyalty?: { rupiahPerPoint: number; pointValue: number; maxRedeemPercent: number };
    /** Zona waktu outlet (menit dari UTC); hanya dikirim bersama promo karena jadwal promo memakainya. */
    utcOffsetMinutes?: number;
    /** Hanya bila outlet punya denah meja. */
    tables?: { no: string; area: string; seats: number }[];
    policy: Record<string, number> | null;
  };
  staff: { id: string; name: string; role: StaffRole; salt: string; hash: string; iterations: number }[];
  /** Promo aktif yang berlaku di outlet ini; ada hanya bila ada. Jadwalnya dihitung dengan `outlet.utcOffsetMinutes`. */
  promos?: Promo[];
  menu: { id: string; name: string; price: number; category: string; modifierGroups?: ModifierGroup[]; /** Versi foto (sidik jari); ada hanya bila menu punya foto. */ image?: string }[];
}

@Injectable()
export class ConfigService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject('PIN_ITERATIONS') private readonly iterations: number,
    @Inject('DASHBOARD_URL') private readonly dashboardUrl: string | undefined,
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
      (await q.query(`select id, name, price, category, sort, outlet_id, active, updated_at, modifier_groups as "modifierGroups"
         , image_version as image from menu_item order by category, sort, name`)).rows,
    );
  }

  /**
   * Menyimpan foto menu (sudah dikecilkan dashboard). Hanya JPEG, PNG, dan WebP dengan tanda pengenal isi yang cocok (bukan SVG: bisa memuat
   * skrip) dan maksimal `MENU_IMAGE_MAX_BYTES`. Versi = sidik jari isi, jadi mengunggah gambar yang sama tidak mengubah versi konfigurasi.
   */
  async setMenuImage(auth: ApiAuth, id: string, input: { contentType?: unknown; data?: unknown }): Promise<{ version: string }> {
    need(typeof input.contentType === 'string' && IMAGE_TYPES.includes(input.contentType), 'jenis gambar harus image/jpeg, image/png, atau image/webp');
    need(typeof input.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(input.data) && input.data.length <= Math.ceil((MENU_IMAGE_MAX_BYTES * 4) / 3) + 4, `gambar harus base64 dan maksimal ${MENU_IMAGE_MAX_BYTES / 1024} KB`);
    const bytes = Buffer.from(input.data as string, 'base64');
    need(bytes.length > 0 && bytes.length <= MENU_IMAGE_MAX_BYTES, `gambar maksimal ${MENU_IMAGE_MAX_BYTES / 1024} KB`);
    need(imageMagicOk(input.contentType as string, bytes), 'isi berkas tidak sesuai jenis gambar yang disebut');
    const version = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await q.query('update menu_item set image = $2, image_type = $3, image_version = $4, updated_at = now() where id = $1 and image_version is distinct from $4', [id, bytes, input.contentType, version]);
      if (r.rowCount === 0 && (await q.query('select 1 from menu_item where id = $1', [id])).rowCount === 0) throw new NotFoundException('menu tidak ditemukan');
      if (r.rowCount > 0) await this.audit(q, auth, 'menu.image', { id, bytes: bytes.length });
    });
    return { version };
  }

  async clearMenuImage(auth: ApiAuth, id: string): Promise<void> {
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await q.query('update menu_item set image = null, image_type = null, image_version = null, updated_at = now() where id = $1', [id]);
      if (r.rowCount === 0) throw new NotFoundException('menu tidak ditemukan');
      await this.audit(q, auth, 'menu.image.remove', { id });
    });
  }

  /** Foto menu untuk dashboard (pengguna) dan terminal (hanya menu aktif yang berlaku di outletnya). */
  async getMenuImage(tenantId: string, id: string, outletId?: string): Promise<{ contentType: string; version: string; data: string }> {
    const row = await this.db.tenantTx(tenantId, async (q) =>
      (await q.query<{ image: Buffer; image_type: string; image_version: string }>(
        `select image, image_type, image_version from menu_item
         where id = $1 and image is not null and ($2::text is null or (active and (outlet_id is null or outlet_id = $2)))`,
        [id, outletId ?? null],
      )).rows[0],
    );
    if (!row) throw new NotFoundException('foto menu tidak ada');
    return { contentType: row.image_type, version: row.image_version, data: Buffer.from(row.image).toString('base64') };
  }

  private checkMenu(i: MenuInput, partial: boolean) {
    if (!partial || i.name !== undefined) need(typeof i.name === 'string' && i.name.trim().length > 0 && i.name.length <= 60, 'nama menu wajib (maks. 60)');
    if (!partial || i.price !== undefined) need(Number.isInteger(i.price) && i.price! >= 0 && i.price! <= 100_000_000, 'harga harus bilangan bulat rupiah ≥ 0');
    if (!partial || i.category !== undefined) need(typeof i.category === 'string' && i.category.trim().length > 0 && i.category.length <= 30, 'kategori wajib (maks. 30)');
    if (i.modifierGroups !== undefined) {
      const bad = checkModifierGroups(i.modifierGroups);
      need(bad === null, bad ?? '');
    }
  }

  async createMenu(auth: ApiAuth, input: MenuInput): Promise<void> {
    need(typeof input.id === 'string' && ID.test(input.id), 'id: huruf kecil, angka, - atau _ (maks. 32)');
    this.checkMenu(input, false);
    await this.db.tenantTx(auth.tenantId, async (q) => {
      if ((await q.query('select 1 from menu_item where id = $1', [input.id])).rowCount > 0) throw new BadRequestException('id menu sudah dipakai');
      if (input.outletId && (await q.query('select 1 from outlet where id = $1', [input.outletId])).rowCount === 0) throw new NotFoundException('outlet tidak ditemukan');
      await q.query(
        'insert into menu_item (tenant_id, id, outlet_id, name, price, category, sort, modifier_groups) values ($1, $2, $3, $4, $5, $6, $7, $8)',
        [auth.tenantId, input.id, input.outletId ?? null, input.name!.trim(), input.price, input.category!.trim(), input.sort ?? 0, JSON.stringify(input.modifierGroups ?? [])],
      );
      await this.audit(q, auth, 'menu.create', { id: input.id, price: input.price });
    });
  }

  /**
   * Impor menu massal dari CSV. `apply: false` (bawaan) hanya memeriksa dan mengembalikan rencana per baris (baru, diubah, tak berubah);
   * `apply: true` menerapkannya sekaligus: bila ada satu baris salah, tidak ada yang berubah. Menu yang id-nya sudah ada hanya diubah nama,
   * kategori, harga, dan statusnya (varian, resep, dan foto tetap); menu baru berlaku di semua outlet. Perubahan harga tercatat di audit.
   */
  async importMenu(auth: ApiAuth, input: { csv?: unknown; apply?: unknown }): Promise<{
    applied: boolean;
    errors: ImportError[];
    plan: { line: number; id: string; action: 'create' | 'update' | 'unchanged'; name: string; changes: string[] }[];
    summary: { create: number; update: number; unchanged: number };
  }> {
    need(typeof input.csv === 'string', 'csv wajib berupa teks');
    need(input.apply === undefined || typeof input.apply === 'boolean', 'apply harus true atau false');
    const parsed = parseMenuCsv(input.csv as string);
    const empty = { create: 0, update: 0, unchanged: 0 };
    if (parsed.errors.length > 0) return { applied: false, errors: parsed.errors, plan: [], summary: empty };
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const have = new Map(
        (await q.query<{ id: string; name: string; price: number; category: string; active: boolean }>('select id, name, price, category, active from menu_item where id = any($1::text[])', [parsed.rows.map((r) => r.id)])).rows.map((r) => [r.id, r]),
      );
      const plan = parsed.rows.map((r) => {
        const old = have.get(r.id);
        if (!old) return { line: r.line, id: r.id, action: 'create' as const, name: r.name, changes: [`harga ${r.price}`] };
        const changes = [
          ...(old.name !== r.name ? [`nama "${old.name}" → "${r.name}"`] : []),
          ...(old.category !== r.category ? [`kategori ${old.category} → ${r.category}`] : []),
          ...(old.price !== r.price ? [`harga ${old.price} → ${r.price}`] : []),
          ...(old.active !== r.active ? [`status ${old.active ? 'aktif' : 'nonaktif'} → ${r.active ? 'aktif' : 'nonaktif'}`] : []),
        ];
        return { line: r.line, id: r.id, action: changes.length > 0 ? ('update' as const) : ('unchanged' as const), name: r.name, changes };
      });
      const summary = { create: plan.filter((p) => p.action === 'create').length, update: plan.filter((p) => p.action === 'update').length, unchanged: plan.filter((p) => p.action === 'unchanged').length };
      if (input.apply !== true) return { applied: false, errors: [], plan, summary };
      for (const r of parsed.rows) {
        const act = plan.find((p) => p.id === r.id)!.action;
        if (act === 'create') {
          await q.query('insert into menu_item (tenant_id, id, outlet_id, name, price, category, sort, active, modifier_groups) values ($1, $2, null, $3, $4, $5, 0, $6, $7)', [auth.tenantId, r.id, r.name, r.price, r.category, r.active, '[]']);
        } else if (act === 'update') {
          await q.query('update menu_item set name = $2, price = $3, category = $4, active = $5, updated_at = now() where id = $1', [r.id, r.name, r.price, r.category, r.active]);
        }
      }
      const priceChanges = parsed.rows.filter((r) => have.has(r.id) && have.get(r.id)!.price !== r.price).slice(0, 50).map((r) => ({ id: r.id, priceFrom: have.get(r.id)!.price, priceTo: r.price }));
      await this.audit(q, auth, 'menu.import', { ...summary, priceChanges });
      return { applied: true, errors: [], plan, summary };
    });
  }

  async updateMenu(auth: ApiAuth, id: string, input: MenuInput): Promise<void> {
    this.checkMenu(input, true);
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const before = (await q.query<{ price: number }>('select price from menu_item where id = $1', [id])).rows[0];
      if (!before) throw new NotFoundException('menu tidak ditemukan');
      await q.query(
        `update menu_item set name = coalesce($2, name), price = coalesce($3, price), category = coalesce($4, category),
                sort = coalesce($5, sort), active = coalesce($6, active), modifier_groups = coalesce($7::jsonb, modifier_groups), updated_at = now() where id = $1`,
        [id, input.name?.trim() ?? null, input.price ?? null, input.category?.trim() ?? null, input.sort ?? null, input.active ?? null,
          input.modifierGroups === undefined ? null : JSON.stringify(input.modifierGroups)],
      );
      await this.audit(q, auth, 'menu.update', { id, ...(input.price !== undefined ? { priceFrom: before.price, priceTo: input.price } : {}), fields: Object.keys(input) });
    });
  }

  // ---------- promo ----------

  listPromos(auth: ApiAuth) {
    return this.db.tenantTx(auth.tenantId, async (q) =>
      (await q.query<PromoRow>(`select ${PROMO_COLUMNS} from promo order by active desc, name`)).rows.map((r) => ({ ...rowToPromo(r), outletId: r.outlet_id, active: r.active })),
    );
  }

  async createPromo(auth: ApiAuth, input: PromoInput): Promise<void> {
    const promo = this.promoFrom({}, input);
    await this.db.tenantTx(auth.tenantId, async (q) => {
      if ((await q.query('select 1 from promo where id = $1', [promo.promo.id])).rowCount > 0) throw new BadRequestException('id promo sudah dipakai');
      await this.checkPromoOutlet(q, promo.outletId);
      await this.writePromo(q, auth.tenantId, promo, true);
      await this.audit(q, auth, 'promo.create', { id: promo.promo.id, kind: promo.promo.kind, value: promo.promo.value });
    });
  }

  async updatePromo(auth: ApiAuth, id: string, input: PromoInput): Promise<void> {
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const row = (await q.query<PromoRow>(`select ${PROMO_COLUMNS} from promo where id = $1`, [id])).rows[0];
      if (!row) throw new NotFoundException('promo tidak ditemukan');
      if (input.id !== undefined && input.id !== id) throw new BadRequestException('id promo tidak bisa diubah');
      const next = this.promoFrom({ ...rowToPromo(row), outletId: row.outlet_id, active: row.active }, { ...input, id });
      await this.checkPromoOutlet(q, next.outletId);
      await this.writePromo(q, auth.tenantId, next, false);
      await this.audit(q, auth, 'promo.update', { id, fields: Object.keys(input) });
    });
  }

  /** Menggabungkan perubahan ke promo lama lalu memeriksa hasil akhirnya secara utuh. */
  private promoFrom(base: Partial<Promo> & { outletId?: string | null; active?: boolean }, input: PromoInput): { promo: Promo; outletId: string | null; active: boolean } {
    const merged: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(input)) {
      if (v === null) delete merged[k];
      else if (v !== undefined) merged[k] = v;
    }
    const { outletId, active, ...rest } = merged as Partial<Promo> & { outletId?: string; active?: boolean };
    const err = checkPromo(rest);
    if (err) throw new BadRequestException(err);
    if (active !== undefined && typeof active !== 'boolean') throw new BadRequestException('active harus true atau false');
    return { promo: rest as Promo, outletId: outletId ?? null, active: active ?? true };
  }

  private async checkPromoOutlet(q: Queryable, outletId: string | null) {
    if (outletId && (await q.query('select 1 from outlet where id = $1', [outletId])).rowCount === 0) throw new NotFoundException('outlet tidak ditemukan');
  }

  private async writePromo(q: Queryable, tenantId: string, x: { promo: Promo; outletId: string | null; active: boolean }, insert: boolean) {
    const p = x.promo;
    const fields = [
      x.outletId, p.name.trim(), p.kind, p.value, p.minSubtotal ?? null, p.maxDiscount ?? null,
      p.days && p.days.length > 0 ? JSON.stringify(p.days) : null, p.startDate ?? null, p.endDate ?? null, p.startHour ?? null, p.endHour ?? null, x.active,
    ];
    if (insert) {
      await q.query(
        `insert into promo (tenant_id, id, outlet_id, name, kind, value, min_subtotal, max_discount, days, start_date, end_date, start_hour, end_hour, active)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)`,
        [tenantId, p.id, ...fields],
      );
    } else {
      await q.query(
        `update promo set outlet_id = $2, name = $3, kind = $4, value = $5, min_subtotal = $6, max_discount = $7, days = $8::jsonb, start_date = $9,
                end_date = $10, start_hour = $11, end_hour = $12, active = $13, updated_at = now() where id = $1`,
        [p.id, ...fields],
      );
    }
  }

  // ---------- pengaturan outlet ----------

  async getSettings(auth: ApiAuth, outletId: string, now = Date.now()) {
    const row = await this.db.tenantTx(auth.tenantId, async (q) =>
      (await q.query<{ shadow_days: number; shadow_started_ms: number | null }>('select id, name, terminals, merchant_name, tax_percent, service_charge_percent, tax_on_service, rounding_unit, loyalty_rupiah_per_point, loyalty_point_value, loyalty_max_redeem_percent, edcs, tables, policy, cctv_retention_days, cctv_clock_offset_sec, shadow_days, shadow_started_ms from outlet where id = $1', [outletId])).rows[0],
    );
    if (!row) throw new NotFoundException('outlet tidak ditemukan');
    const { shadow_started_ms, ...rest } = row;
    return { ...rest, shadow: shadowState(row.shadow_days, shadow_started_ms, now) };
  }

  async updateSettings(auth: ApiAuth, outletId: string, s: SettingsInput, now = Date.now()): Promise<void> {
    if (s.merchantName !== undefined) need(s.merchantName.trim().length > 0 && s.merchantName.length <= 80, 'nama merchant wajib (maks. 80)');
    if (s.taxPercent !== undefined) need(Number.isInteger(s.taxPercent) && s.taxPercent >= 0 && s.taxPercent <= 100, 'taxPercent 0–100');
    if (s.serviceChargePercent !== undefined) need(Number.isInteger(s.serviceChargePercent) && s.serviceChargePercent >= 0 && s.serviceChargePercent <= 30, 'serviceChargePercent 0–30');
    if (s.taxOnService !== undefined) need(typeof s.taxOnService === 'boolean', 'taxOnService harus true atau false');
    if (s.roundingUnit !== undefined) need([0, 100, 500, 1000].includes(s.roundingUnit as number), 'roundingUnit harus 0, 100, 500, atau 1000');
    if (s.edcs !== undefined) {
      need(Array.isArray(s.edcs) && s.edcs.length <= 10, 'edcs maksimal 10');
      for (const e of s.edcs) need(/^[0-9]{6,12}$/.test(e.tid) && !!e.bank?.trim() && !!e.label?.trim(), 'setiap EDC perlu tid (6–12 digit), bank, dan label');
      need(new Set(s.edcs.map((e) => e.tid)).size === s.edcs.length, 'TID EDC tidak boleh ganda');
    }
    if (s.loyalty !== undefined) {
      const l = s.loyalty;
      need(typeof l === 'object' && l !== null, 'loyalty harus berupa objek');
      need(Number.isInteger(l.rupiahPerPoint) && l.rupiahPerPoint >= 0 && l.rupiahPerPoint <= 1_000_000, 'rupiahPerPoint 0–1.000.000 (0 = loyalty mati)');
      need(Number.isInteger(l.pointValue) && l.pointValue >= 0 && l.pointValue <= 1_000_000, 'pointValue 0–1.000.000 (0 = poin tidak bisa ditukar)');
      need(Number.isInteger(l.maxRedeemPercent) && l.maxRedeemPercent >= 1 && l.maxRedeemPercent <= 100, 'maxRedeemPercent 1–100');
      // Menukar poin lebih bernilai daripada memperolehnya = poin bisa dicetak jadi uang. Dicegah di sini, bukan hanya diingatkan.
      need(l.rupiahPerPoint === 0 || l.pointValue <= l.rupiahPerPoint, 'nilai tukar per poin tidak boleh melebihi belanja per poin (rugi pada setiap putaran)');
    }
    if (s.tables !== undefined) {
      need(Array.isArray(s.tables) && s.tables.length <= 200, 'tables maksimal 200');
      for (const t of s.tables) {
        need(typeof t?.no === 'string' && /^[A-Za-z0-9._-]{1,10}$/.test(t.no), 'nomor meja 1–10 karakter (huruf, angka, titik, - atau _)');
        need(typeof t.area === 'string' && t.area.trim().length >= 1 && t.area.length <= 30, 'area meja wajib (maks. 30 karakter)');
        need(Number.isInteger(t.seats) && t.seats >= 1 && t.seats <= 50, 'kursi per meja 1–50');
      }
      need(new Set(s.tables.map((t) => t.no.toLowerCase())).size === s.tables.length, 'nomor meja tidak boleh ganda');
    }
    if (s.policy) {
      for (const [k, v] of Object.entries(s.policy)) {
        need(['secondApprovalAbove', 'manualDiscountMaxPercent', 'manualDiscountMaxAmount', 'employeeMealQuota', 'holdBillMinutes'].includes(k), `kebijakan tidak dikenal: ${k}`);
        if (k === 'holdBillMinutes') need(Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1440, 'holdBillMinutes 0–1440 (0 = bill tunai tidak perlu alasan)');
        else if (k === 'employeeMealQuota') need(Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10, 'employeeMealQuota 0–10 (0 = setiap makan karyawan perlu persetujuan)');
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
                shadow_started_ms = case when $10::boolean then $11::float8 else shadow_started_ms end,
                service_charge_percent = coalesce($12, service_charge_percent), tax_on_service = coalesce($13, tax_on_service),
                rounding_unit = coalesce($14, rounding_unit), tables = coalesce($15::jsonb, tables),
                loyalty_rupiah_per_point = coalesce($16, loyalty_rupiah_per_point), loyalty_point_value = coalesce($17, loyalty_point_value),
                loyalty_max_redeem_percent = coalesce($18, loyalty_max_redeem_percent)
         where id = $1`,
        [
          outletId, s.merchantName?.trim() ?? null, s.taxPercent ?? null, s.edcs ? JSON.stringify(s.edcs) : null,
          s.policy !== undefined, s.policy ? JSON.stringify(s.policy) : null, s.cctvRetentionDays ?? null, s.cctvClockOffsetSec ?? null,
          s.shadowDays ?? null, s.shadowRestart === true, now,
          s.serviceChargePercent ?? null, s.taxOnService ?? null, s.roundingUnit ?? null,
          s.tables ? JSON.stringify(s.tables.map((t) => ({ no: t.no, area: t.area.trim(), seats: t.seats }))) : null,
          s.loyalty?.rupiahPerPoint ?? null, s.loyalty?.pointValue ?? null, s.loyalty?.maxRedeemPercent ?? null,
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
        await q.query<{ id: string; name: string; merchant_name: string | null; tax_percent: number; service_charge_percent: number; tax_on_service: boolean; rounding_unit: number; edcs: DeviceConfig['outlet']['edcs']; tables: NonNullable<DeviceConfig['outlet']['tables']>; utc_offset_minutes: number; loyalty_rupiah_per_point: number; loyalty_point_value: number; loyalty_max_redeem_percent: number; policy: Record<string, number> | null }>(
          'select id, name, merchant_name, tax_percent, service_charge_percent, tax_on_service, rounding_unit, loyalty_rupiah_per_point, loyalty_point_value, loyalty_max_redeem_percent, edcs, tables, policy, utc_offset_minutes from outlet where id = $1',
          [device.outletId],
        )
      ).rows[0];
      if (!o) throw new NotFoundException('outlet tidak ditemukan');
      // Layar dapur tidak perlu (dan tidak boleh memegang) hash PIN staf maupun menu.
      const isKds = device.deviceKind === 'kds';
      const staff = isKds ? [] : (
        await q.query<{ id: string; name: string; role: StaffRole; pin_salt: string; pin_hash: string; pin_iterations: number }>(
          `select id, name, role, pin_salt, pin_hash, pin_iterations from staff
           where active and (outlet_ids is null or jsonb_exists(outlet_ids, $1)) order by id`,
          [device.outletId],
        )
      ).rows;
      const menu = isKds ? [] : (
        await q.query<{ id: string; name: string; price: number; category: string; modifier_groups: ModifierGroup[]; image_version: string | null }>(
          `select id, name, price, category, modifier_groups, image_version from menu_item
           where active and (outlet_id is null or outlet_id = $1) order by category, sort, name`,
          [device.outletId],
        )
      ).rows.map(({ modifier_groups, image_version, ...m }): DeviceConfig['menu'][number] => ({
        ...m,
        ...(modifier_groups.length > 0 ? { modifierGroups: modifier_groups } : {}),
        ...(image_version ? { image: image_version } : {}),
      }));
      const promos = isKds ? [] : (
        await q.query<PromoRow>(`select ${PROMO_COLUMNS} from promo where active and (outlet_id is null or outlet_id = $1) order by name, id`, [device.outletId])
      ).rows.map(rowToPromo);
      const receiptBaseUrl = this.dashboardUrl ? `${this.dashboardUrl.replace(/\/$/, '')}/r/` : undefined;
      const body = {
        ...(receiptBaseUrl ? { receiptBaseUrl } : {}),
        outlet: {
          id: o.id, merchantName: o.merchant_name ?? o.name, taxPercent: o.tax_percent,
          // hanya bila bukan nilai bawaan: konfigurasi outlet lama tidak berubah (versi dan unduhan ulang tetap)
          ...(o.service_charge_percent > 0 ? { serviceChargePercent: o.service_charge_percent } : {}),
          ...(o.tax_on_service === false ? { taxOnService: false } : {}),
          ...(o.rounding_unit > 0 ? { roundingUnit: o.rounding_unit } : {}),
          ...(promos.length > 0 ? { utcOffsetMinutes: o.utc_offset_minutes } : {}),
          ...(o.loyalty_rupiah_per_point > 0 && !isKds ? { loyalty: { rupiahPerPoint: o.loyalty_rupiah_per_point, pointValue: o.loyalty_point_value, maxRedeemPercent: o.loyalty_max_redeem_percent } } : {}),
          edcs: o.edcs, ...(o.tables.length > 0 ? { tables: o.tables } : {}), policy: o.policy,
        },
        staff: staff.map((s) => ({ id: s.id, name: s.name, role: s.role, salt: s.pin_salt, hash: s.pin_hash, iterations: s.pin_iterations })),
        ...(promos.length > 0 ? { promos } : {}),
        menu,
      };
      const version = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
      return { version, serverTime: Date.now(), deviceId: device.deviceId, deviceKind: device.deviceKind, ...body };
    });
  }
}
