import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { consumptionByOrder, usageByIngredient, type Recipes } from '@pos/order';
import type { ApiAuth } from './auth';
import { Database } from './db/database';
import type { Queryable } from './db/driver';
import { EVENT_COLUMNS, rowToEvent, type EventRow } from './guard.service';
import { CLOCK, type Clock } from './pipeline.service';
import { checkBom, flattenRecipes, resolveIngredient, type BomDefs, type BomIngredient } from './bom';
import { buildStock, earliestBaseline, stockAt, varianceFlagged, type IngredientInfo, type Movement, type MovementKind, type StockRow } from './stock';

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const UNITS = ['g', 'ml', 'pcs'] as const;
const KINDS: MovementKind[] = ['PURCHASE', 'WASTE', 'COUNT'];
const MAX_QTY = 1_000_000_000;
const DAY_MS = 86_400_000;
const need = (ok: unknown, message: string): void => {
  if (!ok) throw new BadRequestException(message);
};

export interface IngredientInput { id?: string; name?: string; unit?: string; minStock?: number; active?: boolean; kind?: string; yieldPercent?: number; batchYield?: number }
export interface RecipeInput { optionId?: string | null; lines?: { ingredientId?: string; qty?: number }[] }
export interface MovementInput { ingredientId?: string; kind?: string; qty?: number; note?: string }

interface MovementRow {
  id: string | number; ingredient_id: string; kind: MovementKind; qty: number; expected: number | null; variance: number | null;
  period_used: number | null; note: string | null; user_id: string; at_ms: number;
}
const toMovement = (r: MovementRow): Movement => ({
  id: Number(r.id), ingredientId: r.ingredient_id, kind: r.kind, qty: r.qty, expected: r.expected, variance: r.variance,
  periodUsed: r.period_used, note: r.note, userId: r.user_id, at: Number(r.at_ms),
});

@Injectable()
export class StockService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private audit(q: Queryable, auth: ApiAuth, action: string, detail: object) {
    return q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [auth.tenantId, auth.userId, action, JSON.stringify(detail)]);
  }

  // ---------- bahan ----------

  listIngredients(auth: ApiAuth): Promise<IngredientInfo[]> {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const { ings, defs, minStock } = await this.bomContext(q);
      const memo = new Map();
      return [...ings.values()].sort((a, b) => a.name.localeCompare(b.name)).map((i) => {
        let avgCost = i.avgCost;
        if (i.kind === 'SEMI') {
          try { avgCost = Math.round(resolveIngredient(i.id, ings, defs, memo).cost * 10_000) / 10_000; } catch { avgCost = 0; }
        }
        return { id: i.id, name: i.name, unit: i.unit, minStock: minStock.get(i.id) ?? 0, active: i.active, avgCost, kind: i.kind, yieldPercent: i.yieldPercent, batchYield: i.batchYield };
      });
    });
  }

  /** Bahan beserta jenis, susut, hasil batch, dan BOM bahan setengah jadi (untuk uraian resep dan biaya). */
  async bomContext(q: Queryable): Promise<{ ings: Map<string, BomIngredient>; defs: BomDefs; minStock: Map<string, number> }> {
    const rows = (await q.query<{ id: string; name: string; unit: BomIngredient['unit']; kind: 'RAW' | 'SEMI'; yield_percent: number; batch_yield: number | null; active: boolean; avg_cost: string; min_stock: number }>(
      'select id, name, unit, kind, yield_percent, batch_yield, active, avg_cost, min_stock from ingredient',
    )).rows;
    const ings = new Map(rows.map((r): [string, BomIngredient] => [r.id, { id: r.id, name: r.name, unit: r.unit, kind: r.kind, yieldPercent: r.yield_percent, batchYield: r.batch_yield, active: r.active, avgCost: Number(r.avg_cost) }]));
    const defs: BomDefs = new Map();
    for (const l of (await q.query<{ parent_id: string; child_id: string; qty: number }>('select parent_id, child_id, qty from bom_line')).rows) {
      const m = defs.get(l.parent_id) ?? new Map<string, number>();
      m.set(l.child_id, l.qty);
      defs.set(l.parent_id, m);
    }
    return { ings, defs, minStock: new Map(rows.map((r) => [r.id, r.min_stock])) };
  }

  private checkIngredient(i: IngredientInput, partial: boolean) {
    if (!partial || i.name !== undefined) need(typeof i.name === 'string' && i.name.trim().length > 0 && i.name.length <= 60, 'nama bahan wajib (maks. 60)');
    if (!partial || i.unit !== undefined) need((UNITS as readonly string[]).includes(i.unit as string), 'satuan harus g, ml, atau pcs');
    if (i.kind !== undefined) need(i.kind === 'RAW' || i.kind === 'SEMI', 'jenis harus RAW atau SEMI');
    if (i.yieldPercent !== undefined) need(Number.isInteger(i.yieldPercent) && i.yieldPercent >= 1 && i.yieldPercent <= 100, 'susut: hasil terpakai harus 1–100 persen');
    if (i.batchYield !== undefined) need(Number.isInteger(i.batchYield) && i.batchYield >= 1 && i.batchYield <= 1_000_000, 'hasil batch harus bilangan bulat 1–1.000.000');
    if (i.minStock !== undefined) need(Number.isInteger(i.minStock) && i.minStock >= 0 && i.minStock <= MAX_QTY, 'stok minimum harus bilangan bulat ≥ 0');
  }

  async createIngredient(auth: ApiAuth, input: IngredientInput): Promise<void> {
    need(typeof input.id === 'string' && ID.test(input.id), 'id: huruf kecil, angka, - atau _ (maks. 32)');
    this.checkIngredient(input, false);
    await this.db.tenantTx(auth.tenantId, async (q) => {
      if ((await q.query('select 1 from ingredient where id = $1', [input.id])).rowCount > 0) throw new BadRequestException('id bahan sudah dipakai');
      const kind = input.kind ?? 'RAW';
      need(kind === 'RAW' || input.batchYield !== undefined, 'bahan setengah jadi wajib mengisi hasil batch');
      need(kind === 'SEMI' || input.batchYield === undefined, 'hasil batch hanya untuk bahan setengah jadi');
      need(kind === 'RAW' || input.yieldPercent === undefined, 'susut hanya untuk bahan baku');
      await q.query('insert into ingredient (tenant_id, id, name, unit, min_stock, kind, yield_percent, batch_yield) values ($1, $2, $3, $4, $5, $6, $7, $8)', [auth.tenantId, input.id, input.name!.trim(), input.unit, kind === 'SEMI' ? 0 : input.minStock ?? 0, kind, input.yieldPercent ?? 100, input.batchYield ?? null]);
      await this.audit(q, auth, 'ingredient.create', { id: input.id, unit: input.unit, kind, yieldPercent: input.yieldPercent, batchYield: input.batchYield });
    });
  }

  /** Satuan tidak bisa diubah: angka stok dan resep yang sudah ada akan salah arti. */
  async updateIngredient(auth: ApiAuth, id: string, input: IngredientInput): Promise<void> {
    need(input.unit === undefined, 'satuan bahan tidak bisa diubah; buat bahan baru');
    need(input.kind === undefined, 'jenis bahan tidak bisa diubah; buat bahan baru');
    this.checkIngredient(input, true);
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const cur = (await q.query<{ kind: 'RAW' | 'SEMI'; yield_percent: number; batch_yield: number | null }>('select kind, yield_percent, batch_yield from ingredient where id = $1', [id])).rows[0];
      if (!cur) throw new NotFoundException('bahan tidak ditemukan');
      need(input.yieldPercent === undefined || cur.kind === 'RAW', 'susut hanya untuk bahan baku');
      need(input.batchYield === undefined || cur.kind === 'SEMI', 'hasil batch hanya untuk bahan setengah jadi');
      await q.query(
        'update ingredient set name = coalesce($2, name), min_stock = coalesce($3, min_stock), active = coalesce($4, active), yield_percent = coalesce($5, yield_percent), batch_yield = coalesce($6, batch_yield) where id = $1',
        [id, input.name?.trim() ?? null, input.minStock ?? null, input.active ?? null, input.yieldPercent ?? null, input.batchYield ?? null],
      );
      await this.audit(q, auth, 'ingredient.update', { id, fields: Object.keys(input), ...(input.yieldPercent !== undefined ? { yieldFrom: cur.yield_percent, yieldTo: input.yieldPercent } : {}), ...(input.batchYield !== undefined ? { batchFrom: cur.batch_yield, batchTo: input.batchYield } : {}) });
    });
  }

  // ---------- resep ----------

  /** Resep yang dipakai hitungan (stok, HPP, jurnal): bahan setengah jadi sudah diuraikan ke bahan baku dan susut diperhitungkan. */
  async loadRecipes(q: Queryable): Promise<Recipes> {
    const { ings, defs } = await this.bomContext(q);
    return flattenRecipes(await this.loadRecipesRaw(q), ings, defs);
  }

  /** Resep apa adanya, seperti yang ditulis owner (bahan setengah jadi belum diuraikan). */
  async loadRecipesRaw(q: Queryable): Promise<Recipes> {
    const rows = (await q.query<{ menu_id: string; option_id: string; ingredient_id: string; qty: number }>('select menu_id, option_id, ingredient_id, qty from recipe_line')).rows;
    const recipes: Recipes = { base: new Map(), options: new Map() };
    for (const r of rows) {
      const target = r.option_id === '' ? recipes.base : recipes.options;
      const key = r.option_id === '' ? r.menu_id : `${r.menu_id}|${r.option_id}`;
      const m = target.get(key) ?? new Map<string, number>();
      m.set(r.ingredient_id, r.qty);
      target.set(key, m);
    }
    return recipes;
  }

  /** Semua resep: `{ [menuId]: { base: {bahan: qty}, options: { [optionId]: {bahan: qty} } } }`. */
  recipes(auth: ApiAuth) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await this.loadRecipesRaw(q);
      const out: Record<string, { base: Record<string, number>; options: Record<string, Record<string, number>> }> = {};
      const slot = (menu: string) => (out[menu] ??= { base: {}, options: {} });
      for (const [menu, lines] of r.base) slot(menu).base = Object.fromEntries(lines);
      for (const [key, lines] of r.options) {
        const [menu, opt] = key.split('|') as [string, string];
        slot(menu).options[opt] = Object.fromEntries(lines);
      }
      return out;
    });
  }

  /** Harga pokok rata-rata per bahan (rupiah per satuan terkecil). */
  private async loadCosts(q: Queryable): Promise<Map<string, number>> {
    return new Map((await q.query<{ id: string; avg_cost: string }>('select id, avg_cost from ingredient')).rows.map((r) => [r.id, Number(r.avg_cost)]));
  }

  /**
   * HPP per menu dari resep dasar dan harga pokok rata-rata bahan, dengan margin terhadap harga jual. Tambahan opsi (topping, ukuran) tidak
   * ikut. `missing` = bahan di resep yang belum punya harga pokok (HPP-nya jadi terlalu rendah); menu tanpa resep tidak punya HPP.
   */
  async menuCosts(auth: ApiAuth) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const recipes = await this.loadRecipes(q);
      const costs = await this.loadCosts(q);
      const menu = (await q.query<{ id: string; name: string; price: number; category: string; active: boolean }>('select id, name, price, category, active from menu_item order by category, sort, name')).rows;
      return menu.map((m) => {
        const lines = recipes.base.get(m.id);
        if (!lines || lines.size === 0) return { id: m.id, name: m.name, category: m.category, active: m.active, price: m.price, cost: null, margin: null, marginPct: null, missing: [] as string[] };
        let cost = 0;
        const missing: string[] = [];
        for (const [ing, qty] of lines) {
          const c = costs.get(ing) ?? 0;
          if (c === 0) missing.push(ing);
          cost += qty * c;
        }
        const rounded = Math.round(cost);
        return { id: m.id, name: m.name, category: m.category, active: m.active, price: m.price, cost: rounded, margin: m.price - rounded, marginPct: m.price > 0 ? Math.round(((m.price - rounded) / m.price) * 1000) / 10 : null, missing };
      });
    });
  }

  /**
   * Beban bahan baku (HPP) per hari lokal: pemakaian teoretis dari penjualan × harga pokok rata-rata SAAT INI (riwayat harga per hari tidak
   * disimpan). Bahan tanpa harga pokok tidak dihitung dan dilaporkan di `missing`.
   */
  async cogsByDay(q: Queryable, outletId: string, dayStarts: { date: string; fromMs: number; toMs: number }[], now: number): Promise<{ days: { date: string; amount: number }[]; missing: string[] }> {
    if (dayStarts.length === 0) return { days: [], missing: [] };
    const recipes = await this.loadRecipes(q);
    const costs = await this.loadCosts(q);
    const consumption = await this.consumptionSince(q, outletId, dayStarts[0]!.fromMs, now);
    const missing = new Set<string>();
    const days = dayStarts.map((d) => {
      let amount = 0;
      for (const [ing, qty] of usageByIngredient(consumption, recipes, d.fromMs, d.toMs)) {
        const c = costs.get(ing) ?? 0;
        if (c === 0) missing.add(ing);
        amount += qty * c;
      }
      return { date: d.date, amount: Math.round(amount) };
    });
    return { days, missing: [...missing].sort() };
  }

  /** Mengganti seluruh resep satu lingkup (resep dasar menu, atau tambahan satu opsi). Daftar kosong menghapusnya. */
  async setRecipe(auth: ApiAuth, menuId: string, input: RecipeInput): Promise<void> {
    const optionId = input.optionId ?? '';
    need(typeof optionId === 'string' && (optionId === '' || ID.test(optionId)), 'optionId tidak valid');
    need(Array.isArray(input.lines) && input.lines.length <= 30, 'lines wajib berupa daftar (maks. 30 bahan)');
    const ids = new Set<string>();
    for (const l of input.lines!) {
      need(typeof l.ingredientId === 'string' && ID.test(l.ingredientId), 'ingredientId tidak valid');
      need(Number.isInteger(l.qty) && l.qty! >= 1 && l.qty! <= 1_000_000, `qty ${l.ingredientId} harus bilangan bulat 1–1.000.000`);
      need(!ids.has(l.ingredientId!), `bahan ganda: ${l.ingredientId}`);
      ids.add(l.ingredientId!);
    }
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const menu = (await q.query<{ modifier_groups: { options: { id: string }[] }[] }>('select modifier_groups from menu_item where id = $1', [menuId])).rows[0];
      if (!menu) throw new NotFoundException('menu tidak ditemukan');
      if (optionId !== '') need(menu.modifier_groups.some((g) => g.options.some((o) => o.id === optionId)), 'opsi tidak ada pada menu ini');
      for (const id of ids) {
        const ing = (await q.query<{ active: boolean; kind: string }>('select active, kind from ingredient where id = $1', [id])).rows[0];
        need(ing, `bahan tidak ditemukan: ${id}`);
        // Bahan setengah jadi tanpa BOM tidak bisa diuraikan: pemakaian bahan bakunya akan diam-diam tidak terhitung.
        if (ing!.kind === 'SEMI') need((await q.query('select 1 from bom_line where parent_id = $1', [id])).rowCount > 0, `bahan setengah jadi ${id} belum punya BOM: isi BOM-nya dulu`);
      }
      await q.query('delete from recipe_line where menu_id = $1 and option_id = $2', [menuId, optionId]);
      for (const l of input.lines!) {
        await q.query('insert into recipe_line (tenant_id, menu_id, option_id, ingredient_id, qty) values ($1, $2, $3, $4, $5)', [auth.tenantId, menuId, optionId, l.ingredientId, l.qty]);
      }
      await this.audit(q, auth, 'recipe.set', { menuId, optionId, lines: input.lines });
    });
  }

  // ---------- BOM bahan setengah jadi ----------

  /** BOM semua bahan setengah jadi: `{ [bahanId]: { batchYield, lines: { [bahanId]: qty per batch } } }`. */
  boms(auth: ApiAuth) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const { ings, defs } = await this.bomContext(q);
      const out: Record<string, { batchYield: number | null; lines: Record<string, number> }> = {};
      for (const i of ings.values()) if (i.kind === 'SEMI') out[i.id] = { batchYield: i.batchYield, lines: Object.fromEntries(defs.get(i.id) ?? []) };
      return out;
    });
  }

  /** Mengganti seluruh BOM satu bahan setengah jadi (per batch). Siklus dan kedalaman lebih dari 5 tingkat ditolak. */
  async setBom(auth: ApiAuth, parentId: string, input: { lines?: { ingredientId?: string; qty?: number }[] }): Promise<void> {
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const { ings, defs } = await this.bomContext(q);
      const proposed = new Map(defs);
      proposed.set(parentId, new Map((Array.isArray(input.lines) ? input.lines : []).filter((l) => typeof l?.ingredientId === 'string' && Number.isInteger(l.qty)).map((l) => [l.ingredientId!, l.qty!])));
      const problem = checkBom(parentId, input.lines, ings, proposed);
      if (problem) {
        if (problem === 'bahan tidak ditemukan') throw new NotFoundException(problem);
        throw new BadRequestException(problem);
      }
      await q.query('delete from bom_line where parent_id = $1', [parentId]);
      for (const l of input.lines!) await q.query('insert into bom_line (tenant_id, parent_id, child_id, qty) values ($1, $2, $3, $4)', [auth.tenantId, parentId, l.ingredientId, l.qty]);
      await this.audit(q, auth, 'bom.set', { parentId, before: Object.fromEntries(defs.get(parentId) ?? []), after: Object.fromEntries(proposed.get(parentId)!) });
    });
  }

  // ---------- stok ----------

  private async assertOutlet(q: Queryable, outletId: string) {
    if ((await q.query('select 1 from outlet where id = $1', [outletId])).rowCount === 0) throw new NotFoundException('outlet tidak ditemukan');
  }

  private async loadMovements(q: Queryable, outletId: string, ingredientId?: string): Promise<Movement[]> {
    return (
      await q.query<MovementRow>(
        `select id, ingredient_id, kind, qty, expected, variance, period_used, note, user_id, at_ms from stock_movement
         where outlet_id = $1 and ($2::text is null or ingredient_id = $2) order by at_ms, id`,
        [outletId, ingredientId ?? null],
      )
    ).rows.map(toMovement);
  }

  /** Event penjualan sejak `fromMs` (dilonggarkan 2 hari: terminal bisa mengirim terlambat), diubah menjadi pemakaian per order. */
  async consumptionSince(q: Queryable, outletId: string, fromMs: number, now: number) {
    const rows = (
      await q.query<EventRow>(
        `select ${EVENT_COLUMNS} from event
         where outlet_id = $1 and type in ('order.sent_to_kitchen', 'bill.printed', 'void.approved', 'order.items_moved')
           and device_time_ms >= $2 and device_time_ms <= $3
         order by device_id, seq`,
        [outletId, fromMs - 2 * DAY_MS, now + DAY_MS],
      )
    ).rows;
    return consumptionByOrder(rows.map(rowToEvent));
  }

  async stock(auth: ApiAuth, outletId: string, now = this.clock()): Promise<StockRow[]> {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      await this.assertOutlet(q, outletId);
      const ingredients = (await this.listIngredientsTx(q)).filter((i) => i.active && i.kind !== 'SEMI');
      const movements = await this.loadMovements(q, outletId);
      const from = earliestBaseline(movements);
      const consumption = from === null ? [] : await this.consumptionSince(q, outletId, from, now);
      return buildStock({ ingredients, movements, consumption, recipes: await this.loadRecipes(q), now });
    });
  }

  private async listIngredientsTx(q: Queryable): Promise<IngredientInfo[]> {
    return (await q.query<{ id: string; name: string; unit: IngredientInfo['unit']; min_stock: number; active: boolean; kind: 'RAW' | 'SEMI' }>('select id, name, unit, min_stock, active, kind from ingredient order by name')).rows
      .map((r) => ({ id: r.id, name: r.name, unit: r.unit, minStock: r.min_stock, active: r.active, kind: r.kind }));
  }

  /**
   * Mencatat pembelian, pembuangan (wajib beralasan), atau hitung fisik. Hitung fisik menyimpan perkiraan sistem pada saat itu,
   * selisihnya, dan pemakaian teoretis periodenya, sehingga catatan opname bisa diaudit sendiri. Selisih negatif besar = bahan hilang
   * lebih banyak daripada yang dijelaskan penjualan.
   */
  async addMovement(auth: ApiAuth, outletId: string, input: MovementInput, now = this.clock()): Promise<Movement> {
    need(typeof input.ingredientId === 'string' && ID.test(input.ingredientId), 'ingredientId tidak valid');
    need((KINDS as string[]).includes(input.kind as string), 'kind harus PURCHASE, WASTE, atau COUNT');
    const kind = input.kind as MovementKind;
    need(Number.isInteger(input.qty) && input.qty! >= 0 && input.qty! <= MAX_QTY, 'qty harus bilangan bulat ≥ 0');
    if (kind !== 'COUNT') need(input.qty! > 0, 'qty pembelian atau pembuangan harus lebih dari 0');
    const note = input.note?.trim() || null;
    need(note === null || note.length <= 140, 'catatan maks. 140 karakter');
    if (kind === 'WASTE') need(note !== null, 'pembuangan wajib disertai alasan (catatan)');

    return this.db.tenantTx(auth.tenantId, async (q) => {
      await this.assertOutlet(q, outletId);
      const ing = (await q.query<{ active: boolean; kind: string }>('select active, kind from ingredient where id = $1', [input.ingredientId])).rows[0];
      if (!ing) throw new NotFoundException('bahan tidak ditemukan');
      need(ing.active, 'bahan nonaktif');
      need(ing.kind === 'RAW', 'bahan setengah jadi tidak punya stok sendiri; catat stok bahan bakunya');

      let expected: number | null = null;
      let variance: number | null = null;
      let periodUsed: number | null = null;
      if (kind === 'COUNT') {
        const movements = await this.loadMovements(q, outletId, input.ingredientId);
        const last = movements.filter((m) => m.kind === 'COUNT').at(-1);
        if (last) {
          const consumption = await this.consumptionSince(q, outletId, last.at, now);
          const pos = stockAt(input.ingredientId!, movements, consumption, await this.loadRecipes(q), now);
          expected = pos.expected;
          variance = pos.expected === null ? null : input.qty! - pos.expected;
          periodUsed = pos.used;
        }
      }
      const r = (
        await q.query<MovementRow>(
          `insert into stock_movement (tenant_id, outlet_id, ingredient_id, kind, qty, expected, variance, period_used, note, user_id, at_ms)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           returning id, ingredient_id, kind, qty, expected, variance, period_used, note, user_id, at_ms`,
          [auth.tenantId, outletId, input.ingredientId, kind, input.qty, expected, variance, periodUsed, note, auth.userId, now],
        )
      ).rows[0]!;
      return toMovement(r);
    });
  }

  /** Stok yang diperkirakan satu bahan di satu outlet sekarang (null bila belum pernah dihitung fisik). Dipakai pengadaan untuk menimbang harga rata-rata. */
  async onHand(q: Queryable, outletId: string, ingredientId: string, now: number): Promise<number | null> {
    const movements = await this.loadMovements(q, outletId, ingredientId);
    const from = earliestBaseline(movements);
    if (from === null) return null;
    const consumption = await this.consumptionSince(q, outletId, from, now);
    return stockAt(ingredientId, movements, consumption, await this.loadRecipes(q), now).expected;
  }

  /** Riwayat hitung fisik (opname) dengan selisihnya, terbaru dulu, dengan penanda selisih di atas toleransi. */
  async counts(auth: ApiAuth, outletId: string, limit = 50) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      await this.assertOutlet(q, outletId);
      const names = new Map((await this.listIngredientsTx(q)).map((i) => [i.id, i]));
      const rows = (await this.loadMovements(q, outletId)).filter((m) => m.kind === 'COUNT').reverse().slice(0, Math.min(Math.max(limit, 1), 200));
      return rows.map((m) => ({ ...m, name: names.get(m.ingredientId)?.name ?? m.ingredientId, unit: names.get(m.ingredientId)?.unit ?? 'pcs', flagged: varianceFlagged(m) }));
    });
  }
}
