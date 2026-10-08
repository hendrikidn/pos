import type { Recipes } from '@pos/order';

/**
 * Bill of material (BOM) yang murni (tanpa database). Satuan bahan = satuan terkecil (g, ml, pcs); jumlah boleh pecahan di dalam hitungan dan
 * baru dibulatkan di hasil akhir.
 *
 * Dua jenis bahan: RAW (dibeli) dan SEMI (setengah jadi, dibuat per batch dari bahan lain dengan hasil `batchYield`). Satu satuan bahan RAW
 * dengan `yieldPercent` 80 butuh 100/80 satuan yang dibeli. Bahan SEMI terurai rekursif ke bahan RAW; biayanya dari bahan penyusunnya.
 */

export const MAX_DEPTH = 5;
export const MAX_BOM_LINES = 30;
export const MAX_BATCH_QTY = 1_000_000;

export interface BomIngredient {
  id: string;
  name: string;
  unit: 'g' | 'ml' | 'pcs';
  kind: 'RAW' | 'SEMI';
  yieldPercent: number;
  batchYield: number | null;
  active: boolean;
  /** Harga pokok rata-rata per satuan (bahan RAW). */
  avgCost: number;
}

/** BOM bahan SEMI: `parentId → (childId → jumlah per batch)`. */
export type BomDefs = Map<string, Map<string, number>>;

export interface Resolved {
  /** Kebutuhan bahan RAW (yang dibeli, setelah susut) untuk SATU satuan bahan ini. */
  raw: Map<string, number>;
  /** Biaya SATU satuan bahan ini (rupiah, pecahan). */
  cost: number;
  /** Ada bahan RAW di dalamnya yang belum punya harga pokok (biaya terlalu rendah). */
  unpriced: Set<string>;
  depth: number;
}

export class BomError extends Error {}

/** Mengurai satu satuan bahan ke bahan RAW dan biayanya. Melempar `BomError` untuk siklus, kedalaman berlebih, atau bahan tak dikenal. */
export function resolveIngredient(id: string, ings: Map<string, BomIngredient>, defs: BomDefs, memo = new Map<string, Resolved>(), path: string[] = []): Resolved {
  const hit = memo.get(id);
  if (hit) return hit;
  const ing = ings.get(id);
  if (!ing) throw new BomError(`bahan tidak dikenal: ${id}`);
  if (path.includes(id)) throw new BomError(`siklus pada BOM: ${[...path, id].join(' → ')}`);
  if (ing.kind === 'SEMI' && path.length >= MAX_DEPTH) throw new BomError(`BOM terlalu dalam (maks. ${MAX_DEPTH} tingkat bahan setengah jadi): ${[...path, id].join(' → ')}`);
  let out: Resolved;
  if (ing.kind === 'RAW') {
    const per = 100 / ing.yieldPercent;
    out = { raw: new Map([[id, per]]), cost: ing.avgCost * per, unpriced: ing.avgCost === 0 ? new Set([id]) : new Set(), depth: 0 };
  } else {
    const batch = ing.batchYield;
    if (!batch) throw new BomError(`hasil batch ${id} belum diisi`);
    const lines = defs.get(id);
    if (!lines || lines.size === 0) throw new BomError(`bahan setengah jadi ${id} belum punya BOM`);
    const raw = new Map<string, number>();
    const unpriced = new Set<string>();
    let cost = 0;
    let depth = 0;
    for (const [child, qty] of lines) {
      const r = resolveIngredient(child, ings, defs, memo, [...path, id]);
      for (const [rid, rq] of r.raw) raw.set(rid, (raw.get(rid) ?? 0) + (qty * rq) / batch);
      for (const u of r.unpriced) unpriced.add(u);
      cost += (qty * r.cost) / batch;
      depth = Math.max(depth, r.depth + 1);
    }
    out = { raw, cost, unpriced, depth };
  }
  memo.set(id, out);
  return out;
}

/** Memeriksa BOM baru untuk satu bahan SEMI: pesan kesalahan atau null. `defs` sudah memuat BOM usulan itu. */
export function checkBom(parentId: string, lines: unknown, ings: Map<string, BomIngredient>, defs: BomDefs): string | null {
  const parent = ings.get(parentId);
  if (!parent) return 'bahan tidak ditemukan';
  if (parent.kind !== 'SEMI') return 'hanya bahan setengah jadi yang punya BOM';
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > MAX_BOM_LINES) return `BOM wajib berisi 1–${MAX_BOM_LINES} bahan`;
  const seen = new Set<string>();
  for (const raw of lines as { ingredientId?: unknown; qty?: unknown }[]) {
    const id = raw?.ingredientId;
    if (typeof id !== 'string') return 'ingredientId tidak valid';
    if (id === parentId) return 'bahan tidak boleh memuat dirinya sendiri';
    const child = ings.get(id);
    if (!child) return `bahan tidak ditemukan: ${id}`;
    if (!child.active) return `bahan nonaktif: ${id}`;
    if (seen.has(id)) return `bahan ganda: ${id}`;
    seen.add(id);
    if (!Number.isInteger(raw.qty) || (raw.qty as number) < 1 || (raw.qty as number) > MAX_BATCH_QTY) return `jumlah ${id} per batch harus bilangan bulat 1–${MAX_BATCH_QTY.toLocaleString('id-ID')}`;
  }
  try {
    resolveIngredient(parentId, ings, defs);
    // Setiap bahan SEMI yang memakai bahan ini juga harus tetap sah (siklus tidak langsung, kedalaman).
    for (const [id, i] of ings) if (i.kind === 'SEMI' && id !== parentId && defs.has(id)) resolveIngredient(id, ings, defs);
  } catch (e) {
    if (e instanceof BomError) return e.message;
    throw e;
  }
  return null;
}

/** Resep menu dengan bahan SEMI diuraikan ke bahan RAW dan susut diperhitungkan; keluarannya dipakai hitung stok dan HPP. Pecahan dipertahankan. */
export function flattenRecipes(recipes: Recipes, ings: Map<string, BomIngredient>, defs: BomDefs): Recipes {
  const memo = new Map<string, Resolved>();
  const expand = (lines: Map<string, number>): Map<string, number> => {
    const out = new Map<string, number>();
    for (const [id, qty] of lines) {
      const ing = ings.get(id);
      if (!ing) { out.set(id, (out.get(id) ?? 0) + qty); continue; } // bahan yang sudah tidak ada: biarkan seperti semula
      let r: Resolved;
      try { r = resolveIngredient(id, ings, defs, memo); } catch { out.set(id, (out.get(id) ?? 0) + qty); continue; } // BOM rusak: jangan menghilangkan pemakaian
      for (const [rid, rq] of r.raw) out.set(rid, (out.get(rid) ?? 0) + qty * rq);
    }
    return out;
  };
  const map = (m: Map<string, Map<string, number>>) => new Map([...m].map(([k, v]) => [k, expand(v)]));
  return { base: map(recipes.base), options: map(recipes.options) };
}

export interface BomMenu { id: string; name: string; price: number; options: Map<string, string> }

export interface CalcItem { menuId: string; qty: number; options?: string[] }

export interface TreeNode {
  id: string;
  name: string;
  unit: string;
  kind: 'RAW' | 'SEMI';
  /** Jumlah yang dibutuhkan (satuan bahan ini), pecahan dibulatkan 2 desimal. */
  qty: number;
  cost: number;
  children?: TreeNode[];
}

export interface CalcResult {
  lines: { menuId: string; name: string; qty: number; options: string[]; revenue: number; cost: number; marginPct: number | null; tree: TreeNode[] }[];
  requirements: { ingredientId: string; name: string; unit: string; qty: number; cost: number; unitCost: number }[];
  totals: { revenue: number; cost: number; margin: number; marginPct: number | null };
  /** Bahan RAW yang belum punya harga pokok: biaya terlalu rendah. */
  unpriced: string[];
  /** Menu yang tidak punya resep (tidak menyumbang kebutuhan). */
  noRecipe: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Pohon satu bahan: anak-anaknya (hanya untuk SEMI) dengan jumlah yang dibutuhkan untuk `qty` satuan bahan itu. */
function nodeOf(id: string, qty: number, ings: Map<string, BomIngredient>, defs: BomDefs, memo: Map<string, Resolved>): TreeNode {
  const ing = ings.get(id)!;
  const r = resolveIngredient(id, ings, defs, memo);
  const node: TreeNode = { id, name: ing.name, unit: ing.unit, kind: ing.kind, qty: r2(qty), cost: Math.round(qty * r.cost) };
  if (ing.kind === 'SEMI') {
    const batch = ing.batchYield!;
    node.children = [...defs.get(id)!].map(([child, per]) => nodeOf(child, (qty * per) / batch, ings, defs, memo));
  }
  return node;
}

/**
 * Menghitung BOM untuk daftar menu × jumlah porsi (dengan opsi yang dipilih): kebutuhan bahan RAW total (setelah susut dan penguraian bahan
 * setengah jadi), biaya, pendapatan menurut harga menu, dan margin. Harga opsi tidak ikut pendapatan (menu dasar saja), seperti HPP di dashboard.
 */
export function calcBom(items: CalcItem[], menus: Map<string, BomMenu>, recipes: Recipes, ings: Map<string, BomIngredient>, defs: BomDefs): CalcResult {
  const memo = new Map<string, Resolved>();
  const need = new Map<string, number>();
  const unpriced = new Set<string>();
  const noRecipe = new Set<string>();
  const lines: CalcResult['lines'] = [];
  let revenue = 0;
  let cost = 0;
  for (const it of items) {
    const menu = menus.get(it.menuId);
    if (!menu) throw new BomError(`menu tidak ditemukan: ${it.menuId}`);
    const scopes: { lines: Map<string, number>; label: string | null }[] = [];
    const base = recipes.base.get(menu.id);
    if (base && base.size > 0) scopes.push({ lines: base, label: null });
    const optionNames: string[] = [];
    for (const o of it.options ?? []) {
      const name = menu.options.get(o);
      if (name === undefined) throw new BomError(`opsi ${o} tidak ada pada menu ${menu.name}`);
      optionNames.push(name);
      const l = recipes.options.get(`${menu.id}|${o}`);
      if (l && l.size > 0) scopes.push({ lines: l, label: name });
    }
    if (!base || base.size === 0) noRecipe.add(menu.name);
    const tree: TreeNode[] = [];
    let lineCost = 0;
    for (const s of scopes) {
      for (const [id, per] of s.lines) {
        if (!ings.has(id)) throw new BomError(`bahan resep tidak dikenal: ${id}`);
        const total = per * it.qty;
        const r = resolveIngredient(id, ings, defs, memo);
        for (const [rid, rq] of r.raw) need.set(rid, (need.get(rid) ?? 0) + total * rq);
        for (const u of r.unpriced) unpriced.add(u);
        lineCost += total * r.cost;
        tree.push(nodeOf(id, total, ings, defs, memo));
      }
    }
    const rev = menu.price * it.qty;
    revenue += rev;
    cost += lineCost;
    lines.push({ menuId: menu.id, name: menu.name, qty: it.qty, options: optionNames, revenue: rev, cost: Math.round(lineCost), marginPct: rev > 0 ? Math.round(((rev - lineCost) / rev) * 1000) / 10 : null, tree });
  }
  const requirements = [...need].map(([id, qty]) => {
    const ing = ings.get(id)!;
    return { ingredientId: id, name: ing.name, unit: ing.unit, qty: Math.ceil(qty - 1e-9), cost: Math.round(qty * ing.avgCost), unitCost: ing.avgCost };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const totalCost = Math.round(cost);
  return {
    lines, requirements,
    totals: { revenue, cost: totalCost, margin: revenue - totalCost, marginPct: revenue > 0 ? Math.round(((revenue - totalCost) / revenue) * 1000) / 10 : null },
    unpriced: [...unpriced].sort(), noRecipe: [...noRecipe].sort(),
  };
}

export interface PlanRow {
  ingredientId: string; name: string; unit: string;
  /** Perkiraan pemakaian selama jendela rencana (bulat ke atas). */
  need: number;
  /** Perkiraan stok sekarang (null = belum pernah dihitung fisik). */
  onHand: number | null;
  /** Kekurangan terhadap kebutuhan (0 bila cukup atau stok tidak diketahui). */
  shortage: number;
  /** Berapa hari stok cukup menurut laju pemakaian rata-rata (null bila stok tidak diketahui atau tanpa pemakaian). */
  daysOfCover: number | null;
  cost: number;
}

/** Rencana kebutuhan bahan: pemakaian harian rata-rata dari riwayat × jumlah hari ke depan, dibanding stok. Urut dari yang paling kurang. */
export function planNeeds(usagePerDay: Map<string, number>, days: number, onHand: Map<string, number | null>, ings: Map<string, BomIngredient>): PlanRow[] {
  const rows: PlanRow[] = [];
  for (const [id, perDay] of usagePerDay) {
    const ing = ings.get(id);
    if (!ing) continue;
    const need = Math.max(0, Math.ceil(perDay * days - 1e-9));
    const have = onHand.get(id) ?? null;
    rows.push({
      ingredientId: id, name: ing.name, unit: ing.unit, need, onHand: have,
      shortage: have === null ? 0 : Math.max(0, need - Math.max(0, have)),
      daysOfCover: have === null || perDay <= 0 ? null : Math.round((Math.max(0, have) / perDay) * 10) / 10,
      cost: Math.round(perDay * days * ing.avgCost),
    });
  }
  return rows.sort((a, b) => b.shortage - a.shortage || (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity) || a.name.localeCompare(b.name));
}
