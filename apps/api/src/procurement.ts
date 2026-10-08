/** Aturan pengadaan yang murni (tanpa database). Uang dalam rupiah; harga satuan per satuan terkecil bahan (g, ml, pcs) boleh pecahan. */

/** Harga di faktur yang melebihi harga di PO lebih dari ini ditandai. */
export const PRICE_TOLERANCE = 0.05;
export const MAX_QTY = 1_000_000_000;
export const MAX_UNIT_COST = 100_000_000;

/** Harga pokok rata-rata bergerak: stok yang ada (bernilai `avg`) digabung dengan pembelian baru. Stok tidak diketahui atau habis = harga pembelian terakhir. */
export function weightedAvgCost(onHand: number | null, avg: number, qty: number, unitCost: number): number {
  const have = onHand !== null && onHand > 0 && avg > 0 ? onHand : 0;
  const total = have + qty;
  if (total <= 0) return unitCost;
  return Math.round(((have * avg + qty * unitCost) / total) * 10_000) / 10_000;
}

/** Harga faktur lebih mahal dari harga PO melebihi toleransi? */
export const priceExceeds = (poCost: number, invoiceCost: number): boolean => invoiceCost > poCost * (1 + PRICE_TOLERANCE) + 1e-9;

/** Nilai satu baris pembelian dibulatkan ke rupiah penuh. */
export const lineAmount = (qty: number, unitCost: number): number => Math.round(qty * unitCost);

export interface LineInput { ingredientId?: unknown; qty?: unknown; unitCost?: unknown }

/** Memeriksa baris PO: pesan kesalahan atau null. Bahan tidak boleh kembar dalam satu PO. */
export function checkPoLines(lines: unknown, ingredients: Map<string, { active: boolean }>): string | null {
  if (!Array.isArray(lines) || lines.length < 1) return 'pesanan minimal satu baris';
  if (lines.length > 100) return 'pesanan maksimal 100 baris';
  const seen = new Set<string>();
  for (const [i, raw] of lines.entries()) {
    const l = raw as LineInput | null;
    if (typeof l !== 'object' || l === null) return `baris ${i + 1} tidak valid`;
    const ing = typeof l.ingredientId === 'string' ? ingredients.get(l.ingredientId) : undefined;
    if (!ing) return `baris ${i + 1}: bahan ${String(l.ingredientId)} tidak ada`;
    if (!ing.active) return `baris ${i + 1}: bahan ${l.ingredientId} nonaktif`;
    if (seen.has(l.ingredientId as string)) return `baris ${i + 1}: bahan ${l.ingredientId} muncul dua kali`;
    seen.add(l.ingredientId as string);
    if (!Number.isInteger(l.qty) || (l.qty as number) < 1 || (l.qty as number) > MAX_QTY) return `baris ${i + 1}: jumlah harus bilangan bulat ≥ 1`;
    const c = l.unitCost;
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > MAX_UNIT_COST || Math.abs(Math.round(c * 10_000) - c * 10_000) > 1e-6) return `baris ${i + 1}: harga satuan 0–${MAX_UNIT_COST} dengan maksimal 4 desimal`;
  }
  return null;
}
