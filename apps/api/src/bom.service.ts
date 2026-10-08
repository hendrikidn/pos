import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { usageByIngredient } from '@pos/order';
import type { ApiAuth } from './auth';
import { BomError, calcBom, flattenRecipes, planNeeds, type BomMenu, type CalcItem } from './bom';
import { Database } from './db/database';
import { CLOCK, type Clock } from './pipeline.service';
import { DAY_MS, localDate } from './sales-report';
import { StockService } from './stock.service';

const need = (ok: unknown, message: string): void => {
  if (!ok) throw new BadRequestException(message);
};
const MAX_ITEMS = 50;
const MAX_PORTIONS = 100_000;

export interface CalcInput { outletId?: unknown; items?: unknown }

/** Kalkulator bill of material: kebutuhan bahan dan biaya untuk daftar menu, dan rencana kebutuhan dari riwayat penjualan. */
@Injectable()
export class BomService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(StockService) private readonly stock: StockService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Perkiraan stok sekarang per bahan baku di satu outlet (null = belum pernah dihitung fisik). */
  private async onHandMap(auth: ApiAuth, outletId: string, now: number): Promise<Map<string, number | null>> {
    return new Map((await this.stock.stock(auth, outletId, now)).map((r) => [r.ingredientId, r.expected]));
  }

  /**
   * Menghitung BOM untuk daftar menu × jumlah porsi (dengan opsi). Hasilnya: kebutuhan bahan baku total (setelah susut dan penguraian
   * bahan setengah jadi), biaya, pendapatan, margin, pohon uraian per menu; dan bila `outletId` diberikan, stok sekarang dan kekurangannya.
   */
  async calc(auth: ApiAuth, input: CalcInput, now = this.clock()) {
    need(Array.isArray(input.items) && input.items.length >= 1 && input.items.length <= MAX_ITEMS, `items wajib berisi 1–${MAX_ITEMS} menu`);
    const items: CalcItem[] = [];
    for (const raw of input.items as { menuId?: unknown; qty?: unknown; options?: unknown }[]) {
      need(typeof raw?.menuId === 'string', 'menuId tidak valid');
      need(Number.isInteger(raw.qty) && (raw.qty as number) >= 1 && (raw.qty as number) <= MAX_PORTIONS, `jumlah porsi 1–${MAX_PORTIONS.toLocaleString('id-ID')}`);
      need(raw.options === undefined || (Array.isArray(raw.options) && raw.options.length <= 10 && raw.options.every((o) => typeof o === 'string')), 'options tidak valid');
      items.push({ menuId: raw.menuId as string, qty: raw.qty as number, ...(raw.options ? { options: raw.options as string[] } : {}) });
    }
    const outletId = input.outletId === undefined || input.outletId === null || input.outletId === '' ? null : input.outletId;
    need(outletId === null || typeof outletId === 'string', 'outletId tidak valid');
    const base = await this.db.tenantTx(auth.tenantId, async (q) => {
      if (outletId && (await q.query('select 1 from outlet where id = $1', [outletId])).rowCount === 0) throw new NotFoundException('outlet tidak ditemukan');
      const menus = new Map((await q.query<{ id: string; name: string; price: number; modifier_groups: { options: { id: string; name: string }[] }[] }>('select id, name, price, modifier_groups from menu_item')).rows
        .map((m): [string, BomMenu] => [m.id, { id: m.id, name: m.name, price: m.price, options: new Map(m.modifier_groups.flatMap((g) => g.options.map((o): [string, string] => [o.id, o.name]))) }]));
      const { ings, defs } = await this.stock.bomContext(q);
      try {
        return calcBom(items, menus, await this.stock.loadRecipesRaw(q), ings, defs);
      } catch (e) {
        if (e instanceof BomError) throw new BadRequestException(e.message);
        throw e;
      }
    });
    if (!outletId) return { ...base, outletId: null };
    const have = await this.onHandMap(auth, outletId as string, now);
    const requirements = base.requirements.map((r) => {
      const onHand = have.get(r.ingredientId) ?? null;
      return { ...r, onHand, shortage: onHand === null ? null : Math.max(0, r.qty - Math.max(0, onHand)) };
    });
    return { ...base, requirements, outletId };
  }

  /**
   * Rencana kebutuhan bahan: pemakaian bahan baku rata-rata per hari buka dari penjualan `history` hari terakhir (hari tanpa penjualan tidak
   * dihitung), dikali `days` hari ke depan, dibanding perkiraan stok. Terurut dari yang paling kurang.
   */
  async plan(auth: ApiAuth, outletId: string, q2: { days?: string; history?: string }, now = this.clock()) {
    const days = q2.days === undefined ? 7 : Number(q2.days);
    const history = q2.history === undefined ? 14 : Number(q2.history);
    need(Number.isInteger(days) && days >= 1 && days <= 31, 'days 1–31');
    need(Number.isInteger(history) && history >= 1 && history <= 60, 'history 1–60');
    const ctx = await this.db.tenantTx(auth.tenantId, async (q) => {
      const o = (await q.query<{ utc_offset_minutes: number }>('select utc_offset_minutes from outlet where id = $1', [outletId])).rows[0];
      if (!o) throw new NotFoundException('outlet tidak ditemukan');
      const from = now - history * DAY_MS;
      const consumption = (await this.stock.consumptionSince(q, outletId, from, now)).filter((c) => c.at > from && c.at <= now);
      const { ings, defs } = await this.stock.bomContext(q);
      const recipes = flattenRecipes(await this.stock.loadRecipesRaw(q), ings, defs);
      const activeDays = new Set(consumption.map((c) => localDate(c.at, o.utc_offset_minutes))).size;
      const used = usageByIngredient(consumption, recipes, from, now);
      return { ings, activeDays, used, orders: consumption.length };
    });
    const perDay = new Map([...ctx.used].map(([id, qty]) => [id, ctx.activeDays > 0 ? qty / ctx.activeDays : 0]));
    const rows = planNeeds(perDay, days, await this.onHandMap(auth, outletId, now), ctx.ings);
    return {
      outletId, days, history, activeDays: ctx.activeDays, orders: ctx.orders, rows,
      totals: { cost: rows.reduce((s, r) => s + r.cost, 0), short: rows.filter((r) => r.shortage > 0).length },
    };
  }
}
