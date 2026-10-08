import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ModifierGroup } from '@pos/order';
import { computeTotals, type CartLine } from '@pos/pos-core';
import type { ApiAuth, DeviceAuth } from './auth';
import { Database } from './db/database';
import type { Queryable } from './db/driver';
import { CLOCK, type Clock } from './pipeline.service';
import { DAY_MS, localDate, startOfLocalDay } from './sales-report';
import { checkCart, MAX_WEB_TOTAL, PHONE_RE, SLUG_RE, WEB_EXPIRE_MS, type MenuRow, type WebLine } from './web-order';

const need = (ok: unknown, message: string): void => {
  if (!ok) throw new BadRequestException(message);
};
const num = (v: unknown) => Number(v);
const clean = (v: unknown, min: number, max: number): string | null => {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  return s.length >= min && s.length <= max ? s : null;
};
const NOT_FOUND = 'toko tidak ditemukan';

const ORDERS_PER_IP_PER_HOUR = 6;
const PENDING_PER_PHONE = 3;
const PENDING_PER_OUTLET = 50;
const READS_PER_IP_PER_MINUTE = 120;

export interface WebOrderInput { name?: unknown; phone?: unknown; type?: unknown; tableNo?: unknown; items?: unknown; note?: unknown; website?: unknown }

interface WebRow {
  id: string; outlet_id: string; token: string; customer_name: string; phone: string; order_type: 'TAKE_AWAY' | 'DINE_IN'; table_no: string | null; items: WebLine[];
  estimated_total: string; note: string | null; status: 'NEW' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED'; created_at_ms: number; decided_by: string | null; decided_at_ms: number | null; decided_reason: string | null;
}
const WEB_COLS = 'id, outlet_id, token, customer_name, phone, order_type, table_no, items, estimated_total, note, status, created_at_ms, decided_by, decided_at_ms, decided_reason';
const codeOf = (id: number) => `W${id}`;

interface ShopOutlet {
  id: string; tenant_id: string; name: string; merchant_name: string | null; tax_percent: number; service_charge_percent: number; tax_on_service: boolean; rounding_unit: number;
  tables: { no: string }[] | null;
}

@Injectable()
export class WebShopService {
  private readonly orderHits = new Map<string, { count: number; resetAt: number }>();
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

  /** Pesanan baru yang tidak ditanggapi 30 menit kedaluwarsa (disapu saat ada yang membaca outlet itu). */
  private async sweep(q: Queryable, outletId: string, now: number) {
    await q.query("update web_order set status = 'EXPIRED' where outlet_id = $1 and status = 'NEW' and created_at_ms < $2", [outletId, now - WEB_EXPIRE_MS]);
  }

  // ---------- publik (tanpa login) ----------

  private async shopBySlug(slug: string): Promise<ShopOutlet> {
    if (!SLUG_RE.test(slug)) throw new NotFoundException(NOT_FOUND);
    // Jalur tanpa tenant: koneksi pemilik skema; semua kueri berikutnya dibatasi oleh outlet hasil pencarian slug ini.
    const o = (await this.db.admin.query<ShopOutlet>(
      `select o.id, o.tenant_id, o.name, o.merchant_name, o.tax_percent, o.service_charge_percent, o.tax_on_service, o.rounding_unit, o.tables
       from outlet o join tenant t on t.id = o.tenant_id where o.web_slug = $1 and o.web_enabled and t.suspended_at is null`, [slug],
    )).rows[0];
    if (!o) throw new NotFoundException(NOT_FOUND);
    return o;
  }

  private async menuOf(q: Queryable, outletId: string) {
    return (await q.query<{ id: string; name: string; price: number; category: string; modifier_groups: ModifierGroup[] }>(
      `select id, name, price, category, modifier_groups from menu_item where active and (outlet_id is null or outlet_id = $1) order by category, sort, name`, [outletId],
    )).rows;
  }

  async publicShop(slug: string, caller: string) {
    this.limit(this.readHits, caller, READS_PER_IP_PER_MINUTE, 60_000, 'terlalu banyak permintaan; coba lagi sebentar');
    const o = await this.shopBySlug(slug);
    const menu = await this.db.tenantTx(o.tenant_id, (q) => this.menuOf(q, o.id));
    return {
      name: o.merchant_name ?? o.name,
      tables: (o.tables ?? []).map((t) => t.no),
      menu: menu.map((m) => ({ id: m.id, name: m.name, price: m.price, category: m.category, modifierGroups: m.modifier_groups })),
      pricing: { taxPercent: o.tax_percent, servicePercent: o.service_charge_percent, taxOnService: o.tax_on_service, roundingUnit: o.rounding_unit },
    };
  }

  async publicOrder(slug: string, input: WebOrderInput, caller: string): Promise<{ token: string; code: string; total: number }> {
    if (typeof input.website === 'string' && input.website.trim() !== '') return { token: randomBytes(16).toString('base64url'), code: 'W0', total: 0 }; // jebakan bot: pura-pura berhasil
    this.limit(this.readHits, caller, READS_PER_IP_PER_MINUTE, 60_000, 'terlalu banyak permintaan; coba lagi sebentar');
    const o = await this.shopBySlug(slug);
    const name = clean(input.name, 2, 40);
    need(name, 'nama wajib diisi (2–40 karakter)');
    const phone = clean(input.phone, 8, 20);
    need(phone && PHONE_RE.test(phone), 'nomor telepon tidak valid');
    need(input.type === 'TAKE_AWAY' || input.type === 'DINE_IN', 'pilih ambil sendiri atau makan di tempat');
    let tableNo: string | null = null;
    if (input.type === 'DINE_IN') {
      tableNo = clean(input.tableNo, 1, 6);
      need(tableNo, 'nomor meja wajib untuk makan di tempat');
      if (o.tables && o.tables.length > 0) need(o.tables.some((t) => t.no === tableNo), 'nomor meja tidak ada');
    }
    const note = input.note === undefined || input.note === null || input.note === '' ? null : clean(input.note, 1, 200);
    need(input.note === undefined || input.note === null || input.note === '' || note !== null, 'catatan maksimal 200 karakter');
    const now = this.clock();
    return this.db.tenantTx(o.tenant_id, async (q) => {
      await this.sweep(q, o.id, now);
      const cart = checkCart(input.items, new Map((await this.menuOf(q, o.id)).map((m) => [m.id, { id: m.id, name: m.name, price: m.price, modifierGroups: m.modifier_groups } as MenuRow])));
      if (!cart.ok) throw new BadRequestException(cart.message);
      const lines: CartLine[] = cart.lines.map((l) => ({ itemId: l.itemId, name: l.name, qty: l.qty, unitPrice: l.unitPrice, sentQty: 0 }));
      const total = computeTotals(lines, 0, { taxPercent: o.tax_percent, servicePercent: o.service_charge_percent, taxOnService: o.tax_on_service, roundingUnit: o.rounding_unit }).total;
      need(total <= MAX_WEB_TOTAL, `nilai pesanan maksimal Rp ${MAX_WEB_TOTAL.toLocaleString('id-ID')}; untuk pesanan lebih besar hubungi outlet`);
      const pending = (await q.query<{ n: string; mine: string }>("select count(*) as n, count(*) filter (where phone = $2) as mine from web_order where outlet_id = $1 and status = 'NEW'", [o.id, phone])).rows[0]!;
      if (num(pending.mine) >= PENDING_PER_PHONE) throw new HttpException('masih ada pesanan Anda yang menunggu konfirmasi kasir', HttpStatus.TOO_MANY_REQUESTS);
      if (num(pending.n) >= PENDING_PER_OUTLET) throw new HttpException('toko sedang ramai; coba lagi sebentar', HttpStatus.TOO_MANY_REQUESTS);
      // Hanya pesanan yang lolos pemeriksaan yang dihitung ke pembatas per alamat, supaya salah ketik tidak menghabiskan jatah.
      this.limit(this.orderHits, caller, ORDERS_PER_IP_PER_HOUR, 3_600_000, 'terlalu banyak pesanan dari perangkat ini; coba lagi nanti atau pesan langsung di kasir');
      const token = randomBytes(16).toString('base64url');
      const id = num((await q.query<{ id: string }>(
        `insert into web_order (tenant_id, outlet_id, token, customer_name, phone, order_type, table_no, items, estimated_total, note, created_at_ms, caller_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12) returning id`,
        [o.tenant_id, o.id, token, name, phone, input.type, tableNo, JSON.stringify(cart.lines), total, note, now, createHash('sha256').update(caller).digest('hex').slice(0, 16)],
      )).rows[0]!.id);
      return { token, code: codeOf(id), total };
    });
  }

  async publicTrack(token: string, caller: string) {
    this.limit(this.readHits, caller, READS_PER_IP_PER_MINUTE, 60_000, 'terlalu banyak permintaan; coba lagi sebentar');
    if (!/^[A-Za-z0-9_-]{22}$/.test(token)) throw new NotFoundException('pesanan tidak ditemukan');
    const r = (await this.db.admin.query<WebRow & { outlet_name: string }>(
      `select w.id, w.outlet_id, w.token, w.customer_name, w.phone, w.order_type, w.table_no, w.items, w.estimated_total, w.note, w.status, w.created_at_ms, w.decided_by, w.decided_at_ms, w.decided_reason,
              coalesce(o.merchant_name, o.name) as outlet_name
       from web_order w join outlet o on o.id = w.outlet_id where w.token = $1`, [token],
    )).rows[0];
    if (!r) throw new NotFoundException('pesanan tidak ditemukan');
    const expired = r.status === 'NEW' && num(r.created_at_ms) < this.clock() - WEB_EXPIRE_MS;
    return {
      outletName: r.outlet_name, code: codeOf(num(r.id)), status: expired ? 'EXPIRED' : r.status, total: num(r.estimated_total), type: r.order_type, tableNo: r.table_no,
      createdAt: num(r.created_at_ms), reason: r.status === 'REJECTED' ? r.decided_reason : null,
      items: r.items.map((l) => ({ name: l.name, qty: l.qty, options: l.options.map((x) => x.name), note: l.note ?? null })),
    };
  }

  // ---------- pengaturan dan daftar (dashboard) ----------

  async settings(auth: ApiAuth, outletId: string) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const o = (await q.query<{ web_slug: string | null; web_enabled: boolean; tables: { no: string }[] | null }>('select web_slug, web_enabled, tables from outlet where id = $1', [outletId])).rows[0];
      if (!o) throw new NotFoundException('outlet tidak ditemukan');
      return { slug: o.web_slug, enabled: o.web_enabled, tables: (o.tables ?? []).map((t) => t.no) };
    });
  }

  async setSettings(auth: ApiAuth, outletId: string, input: { enabled?: unknown; slug?: unknown }): Promise<void> {
    need(typeof input.enabled === 'boolean', 'enabled harus true atau false');
    const slug = input.slug === undefined || input.slug === null || input.slug === '' ? null : typeof input.slug === 'string' ? input.slug.trim().toLowerCase() : '';
    need(slug === null || SLUG_RE.test(slug), 'alamat toko: 3–30 huruf kecil, angka, atau tanda hubung');
    need(!(input.enabled && slug === null), 'isi alamat toko sebelum mengaktifkan');
    await this.db.tenantTx(auth.tenantId, async (q) => {
      if ((await q.query('select 1 from outlet where id = $1', [outletId])).rowCount === 0) throw new NotFoundException('outlet tidak ditemukan');
      try {
        await q.query('update outlet set web_slug = $2, web_enabled = $3 where id = $1', [outletId, slug, input.enabled]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException('alamat toko itu sudah dipakai; pilih yang lain');
        throw e;
      }
      await this.audit(q, auth.tenantId, auth.userId, 'webshop.settings', { outletId, slug, enabled: input.enabled });
    });
  }

  async list(auth: ApiAuth, outletId: string, q2: { days?: string }, now = this.clock()) {
    const days = q2.days === undefined ? 7 : Number(q2.days);
    need(Number.isInteger(days) && days >= 1 && days <= 31, 'days 1–31');
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const o = (await q.query<{ utc_offset_minutes: number }>('select utc_offset_minutes from outlet where id = $1', [outletId])).rows[0];
      if (!o) throw new NotFoundException('outlet tidak ditemukan');
      await this.sweep(q, outletId, now);
      const from = startOfLocalDay(localDate(now, o.utc_offset_minutes), o.utc_offset_minutes) - (days - 1) * DAY_MS;
      const rows = (await q.query<WebRow>(`select ${WEB_COLS} from web_order where outlet_id = $1 and created_at_ms >= $2 order by created_at_ms desc, id desc limit 300`, [outletId, from])).rows;
      return rows.map((r) => this.dashView(r));
    });
  }

  private dashView(r: WebRow) {
    return {
      id: num(r.id), code: codeOf(num(r.id)), name: r.customer_name, phone: r.phone, type: r.order_type, tableNo: r.table_no, note: r.note, status: r.status,
      total: num(r.estimated_total), createdAt: num(r.created_at_ms), decidedBy: r.decided_by, decidedAt: r.decided_at_ms === null ? null : num(r.decided_at_ms), reason: r.decided_reason,
      items: r.items.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, options: l.options.map((x) => x.name), note: l.note ?? null })),
    };
  }

  /** Menolak pesanan dari dashboard (manager/owner). */
  async rejectFromDashboard(auth: ApiAuth, outletId: string, id: number, reason: unknown, now = this.clock()): Promise<void> {
    const why = clean(reason, 2, 140);
    need(why, 'alasan wajib (2–140 karakter)');
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await q.query("update web_order set status = 'REJECTED', decided_by = $3, decided_at_ms = $4, decided_reason = $5 where id = $1 and outlet_id = $2 and status = 'NEW' and created_at_ms >= $6", [id, outletId, auth.userId, now, why, now - WEB_EXPIRE_MS]);
      if (r.rowCount === 0) throw new ConflictException('pesanan tidak ditemukan atau sudah diputuskan');
      await this.audit(q, auth.tenantId, auth.userId, 'webshop.reject', { id, outletId, reason: why });
    });
  }

  // ---------- terminal POS ----------

  /** Pesanan baru yang menunggu kasir (belum kedaluwarsa), lengkap dengan isi dan nama pemesan. */
  async pending(device: DeviceAuth, now = this.clock()) {
    return this.db.tenantTx(device.tenantId, async (q) => {
      await this.sweep(q, device.outletId, now);
      const rows = (await q.query<WebRow>(`select ${WEB_COLS} from web_order where outlet_id = $1 and status = 'NEW' order by created_at_ms, id`, [device.outletId])).rows;
      return {
        at: now,
        orders: rows.map((r) => ({
          id: num(r.id), code: codeOf(num(r.id)), name: r.customer_name, phone: r.phone, type: r.order_type, tableNo: r.table_no, note: r.note, total: num(r.estimated_total), createdAt: num(r.created_at_ms),
          items: r.items.map((l) => ({ itemId: l.itemId, name: l.name, qty: l.qty, unitPrice: l.unitPrice, options: l.options.map((x) => x.optionId), optionNames: l.options.map((x) => x.name), note: l.note ?? null })),
        })),
      };
    });
  }

  /** Klaim atomik: hanya satu terminal yang berhasil menerima pesanan yang masih baru. Isinya dikembalikan untuk dibuat sebagai order kasir. */
  async accept(device: DeviceAuth, id: number, now = this.clock()) {
    return this.db.tenantTx(device.tenantId, async (q) => {
      const r = (await q.query<WebRow>(
        `update web_order set status = 'ACCEPTED', decided_by = $3, decided_at_ms = $4 where id = $1 and outlet_id = $2 and status = 'NEW' and created_at_ms >= $5 returning ${WEB_COLS}`,
        [id, device.outletId, `device:${device.deviceId}`, now, now - WEB_EXPIRE_MS],
      )).rows[0];
      if (!r) throw new ConflictException('pesanan sudah diterima terminal lain, ditolak, atau kedaluwarsa');
      await this.audit(q, device.tenantId, `device:${device.deviceId}`, 'webshop.accept', { id, outletId: device.outletId });
      return {
        id: num(r.id), code: codeOf(num(r.id)), name: r.customer_name, type: r.order_type, tableNo: r.table_no ?? undefined,
        items: r.items.map((l) => ({ itemId: l.itemId, name: l.name, qty: l.qty, options: l.options.map((x) => x.optionId), ...(l.note ? { note: l.note } : {}) })),
      };
    });
  }

  async rejectFromDevice(device: DeviceAuth, id: number, reason: unknown, now = this.clock()): Promise<void> {
    const why = clean(reason, 2, 140);
    need(why, 'alasan wajib (2–140 karakter)');
    await this.db.tenantTx(device.tenantId, async (q) => {
      const r = await q.query("update web_order set status = 'REJECTED', decided_by = $3, decided_at_ms = $4, decided_reason = $5 where id = $1 and outlet_id = $2 and status = 'NEW' and created_at_ms >= $6", [id, device.outletId, `device:${device.deviceId}`, now, why, now - WEB_EXPIRE_MS]);
      if (r.rowCount === 0) throw new ConflictException('pesanan sudah diputuskan atau kedaluwarsa');
      await this.audit(q, device.tenantId, `device:${device.deviceId}`, 'webshop.reject', { id, outletId: device.outletId, reason: why });
    });
  }
}
