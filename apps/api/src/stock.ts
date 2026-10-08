import { usageByIngredient, type OrderConsumption, type Recipes } from '@pos/order';

export type MovementKind = 'PURCHASE' | 'WASTE' | 'COUNT';

export interface Movement {
  id: number;
  ingredientId: string;
  kind: MovementKind;
  qty: number;
  expected: number | null;
  variance: number | null;
  periodUsed: number | null;
  note: string | null;
  userId: string;
  at: number;
}

export interface IngredientInfo {
  id: string;
  name: string;
  unit: 'g' | 'ml' | 'pcs';
  minStock: number;
  active: boolean;
}

export interface StockPosition {
  /** Hitung fisik terakhir; null bila belum pernah dihitung (stok awal belum ada). */
  baseline: { at: number; counted: number } | null;
  purchased: number;
  wasted: number;
  /** Pemakaian teoretis dari penjualan sejak baseline. */
  used: number;
  /** baseline + beli − buang − pakai; null tanpa baseline. Bisa negatif bila pencatatan tertinggal. */
  expected: number | null;
}

/** Selisih opname di atas ini (relatif terhadap pemakaian periode itu) ditandai: pada 5% pemakaian atau lebih. */
export const VARIANCE_TOLERANCE = 0.05;

/**
 * Posisi stok satu bahan di satu outlet pada waktu `at`, dari pergerakan (urut waktu), pemakaian teoretis, dan resep.
 * Baseline = hitung fisik (COUNT) terakhir sebelum atau tepat pada `at`. Pergerakan sebelum baseline tidak dihitung lagi.
 */
export function stockAt(
  ingredientId: string, movements: Movement[], consumption: OrderConsumption[], recipes: Recipes, at: number,
): StockPosition {
  const mine = movements.filter((m) => m.ingredientId === ingredientId && m.at <= at).sort((a, b) => a.at - b.at || a.id - b.id);
  let b: Movement | undefined;
  for (const m of mine) if (m.kind === 'COUNT') b = m;
  if (!b) {
    return { baseline: null, purchased: sum(mine, 'PURCHASE'), wasted: sum(mine, 'WASTE'), used: 0, expected: null };
  }
  const after = mine.filter((m) => m.at > b!.at || (m.at === b!.at && m.id > b!.id));
  const purchased = sum(after, 'PURCHASE');
  const wasted = sum(after, 'WASTE');
  const used = usageByIngredient(consumption, recipes, b.at, at).get(ingredientId) ?? 0;
  return { baseline: { at: b.at, counted: b.qty }, purchased, wasted, used, expected: b.qty + purchased - wasted - used };
}

const sum = (list: Movement[], kind: MovementKind) => list.filter((m) => m.kind === kind).reduce((s, m) => s + m.qty, 0);

export type StockStatus = 'NO_BASELINE' | 'OK' | 'LOW' | 'EMPTY';

export interface StockRow extends StockPosition {
  ingredientId: string;
  name: string;
  unit: IngredientInfo['unit'];
  minStock: number;
  active: boolean;
  status: StockStatus;
  lastCount: Movement | null;
  /** Pergerakan terbaru (maks. 10), yang terbaru dulu. */
  recent: Movement[];
}

export const statusOf = (expected: number | null, minStock: number): StockStatus =>
  expected === null ? 'NO_BASELINE' : expected <= 0 ? 'EMPTY' : expected <= minStock ? 'LOW' : 'OK';

/** Selisih opname ditandai bila lebih dari toleransi (5%) pemakaian periodenya, atau ada selisih saat tidak ada pemakaian. */
export function varianceFlagged(m: Pick<Movement, 'variance' | 'periodUsed'>): boolean {
  if (m.variance === null || m.variance === 0) return false;
  const tol = Math.ceil((m.periodUsed ?? 0) * VARIANCE_TOLERANCE);
  return Math.abs(m.variance) > tol;
}

export function buildStock(input: {
  ingredients: IngredientInfo[]; movements: Movement[]; consumption: OrderConsumption[]; recipes: Recipes; now: number;
}): StockRow[] {
  return input.ingredients.map((ing) => {
    const own = input.movements.filter((m) => m.ingredientId === ing.id).sort((a, b) => b.at - a.at || b.id - a.id);
    const pos = stockAt(ing.id, input.movements, input.consumption, input.recipes, input.now);
    return {
      ...pos, ingredientId: ing.id, name: ing.name, unit: ing.unit, minStock: ing.minStock, active: ing.active,
      status: statusOf(pos.expected, ing.minStock),
      lastCount: own.find((m) => m.kind === 'COUNT') ?? null,
      recent: own.slice(0, 10),
    };
  });
}
