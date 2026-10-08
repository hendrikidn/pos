import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { consumptionByOrder, type Recipes } from '@pos/order';
import type { ApiAuth } from './auth';
import { Database } from './db/database';
import type { Queryable } from './db/driver';
import { EVENT_COLUMNS, rowToEvent, type EventRow } from './guard.service';
import { CLOCK, type Clock } from './pipeline.service';
import { buildStock, earliestBaseline, stockAt, varianceFlagged, type IngredientInfo, type Movement, type MovementKind, type StockRow } from './stock';

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const UNITS = ['g', 'ml', 'pcs'] as const;
const KINDS: MovementKind[] = ['PURCHASE', 'WASTE', 'COUNT'];
const MAX_QTY = 1_000_000_000;
const DAY_MS = 86_400_000;
const need = (ok: unknown, message: string): void => {
  if (!ok) throw new BadRequestException(message);
};

export interface IngredientInput { id?: string; name?: string; unit?: string; minStock?: number; active?: boolean }
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
    return this.db.tenantTx(auth.tenantId, async (q) =>
      (await q.query<{ id: string; name: string; unit: IngredientInfo['unit']; min_stock: number; active: boolean }>('select id, name, unit, min_stock, active from ingredient order by name')).rows
        .map((r) => ({ id: r.id, name: r.name, unit: r.unit, minStock: r.min_stock, active: r.active })),
    );
  }

  private checkIngredient(i: IngredientInput, partial: boolean) {
    if (!partial || i.name !== undefined) need(typeof i.name === 'string' && i.name.trim().length > 0 && i.name.length <= 60, 'nama bahan wajib (maks. 60)');
    if (!partial || i.unit !== undefined) need((UNITS as readonly string[]).includes(i.unit as string), 'satuan harus g, ml, atau pcs');
    if (i.minStock !== undefined) need(Number.isInteger(i.minStock) && i.minStock >= 0 && i.minStock <= MAX_QTY, 'stok minimum harus bilangan bulat ≥ 0');
  }

  async createIngredient(auth: ApiAuth, input: IngredientInput): Promise<void> {
    need(typeof input.id === 'string' && ID.test(input.id), 'id: huruf kecil, angka, - atau _ (maks. 32)');
    this.checkIngredient(input, false);
    await this.db.tenantTx(auth.tenantId, async (q) => {
      if ((await q.query('select 1 from ingredient where id = $1', [input.id])).rowCount > 0) throw new BadRequestException('id bahan sudah dipakai');
      await q.query('insert into ingredient (tenant_id, id, name, unit, min_stock) values ($1, $2, $3, $4, $5)', [auth.tenantId, input.id, input.name!.trim(), input.unit, input.minStock ?? 0]);
      await this.audit(q, auth, 'ingredient.create', { id: input.id, unit: input.unit });
    });
  }

  /** Satuan tidak bisa diubah: angka stok dan resep yang sudah ada akan salah arti. */
  async updateIngredient(auth: ApiAuth, id: string, input: IngredientInput): Promise<void> {
    need(input.unit === undefined, 'satuan bahan tidak bisa diubah; buat bahan baru');
    this.checkIngredient(input, true);
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await q.query(
        'update ingredient set name = coalesce($2, name), min_stock = coalesce($3, min_stock), active = coalesce($4, active) where id = $1',
        [id, input.name?.trim() ?? null, input.minStock ?? null, input.active ?? null],
      );
      if (!r.rowCount) throw new NotFoundException('bahan tidak ditemukan');
      await this.audit(q, auth, 'ingredient.update', { id, fields: Object.keys(input) });
    });
  }

  // ---------- resep ----------

  private async loadRecipes(q: Queryable): Promise<Recipes> {
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
      const r = await this.loadRecipes(q);
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
        const ing = (await q.query<{ active: boolean }>('select active from ingredient where id = $1', [id])).rows[0];
        need(ing, `bahan tidak ditemukan: ${id}`);
      }
      await q.query('delete from recipe_line where menu_id = $1 and option_id = $2', [menuId, optionId]);
      for (const l of input.lines!) {
        await q.query('insert into recipe_line (tenant_id, menu_id, option_id, ingredient_id, qty) values ($1, $2, $3, $4, $5)', [auth.tenantId, menuId, optionId, l.ingredientId, l.qty]);
      }
      await this.audit(q, auth, 'recipe.set', { menuId, optionId, lines: input.lines });
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
  private async consumptionSince(q: Queryable, outletId: string, fromMs: number, now: number) {
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
      const ingredients = (await this.listIngredientsTx(q)).filter((i) => i.active);
      const movements = await this.loadMovements(q, outletId);
      const from = earliestBaseline(movements);
      const consumption = from === null ? [] : await this.consumptionSince(q, outletId, from, now);
      return buildStock({ ingredients, movements, consumption, recipes: await this.loadRecipes(q), now });
    });
  }

  private async listIngredientsTx(q: Queryable): Promise<IngredientInfo[]> {
    return (await q.query<{ id: string; name: string; unit: IngredientInfo['unit']; min_stock: number; active: boolean }>('select id, name, unit, min_stock, active from ingredient order by name')).rows
      .map((r) => ({ id: r.id, name: r.name, unit: r.unit, minStock: r.min_stock, active: r.active }));
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
      const ing = (await q.query<{ active: boolean }>('select active from ingredient where id = $1', [input.ingredientId])).rows[0];
      if (!ing) throw new NotFoundException('bahan tidak ditemukan');
      need(ing.active, 'bahan nonaktif');

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
