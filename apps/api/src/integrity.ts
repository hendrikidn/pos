import { VARIANCE_TOLERANCE } from './stock';

/**
 * Aturan integritas berbasis data server (bukan aliran event): harga beli (R50, R51), stok (R15), resep (R52), absen (R53), dan kertas (R16).
 * Fungsi di sini murni; pengambilan datanya ada di `integrity-hits.ts`.
 */

export const DAY_MS = 86_400_000;
/** R50: harga beli lebih mahal dari supplier lain sebesar ini, dan selisih nilainya minimal. */
export const R50_MARKUP = 0.15;
export const R50_MIN_EXCESS = 20_000;
export const R50_REFERENCE_DAYS = 90;
/** R51: selisih nilai faktur terhadap PO minimal. */
export const R51_MIN_EXCESS = 10_000;
export const R51_TOLERANCE = 0.05;
/** R15: nilai kekurangan opname minimal (rupiah). */
export const R15_MIN_VALUE = 25_000;
/** R52: pengurangan jumlah bahan di resep/BOM, dan seberapa lama sebelumnya selisih opname dihitung. */
export const R52_REDUCTION = 0.2;
export const R52_LOOKBACK_MS = 14 * DAY_MS;
/** R53: koreksi absen per staf dalam jendela, dan satu koreksi yang sangat panjang. */
export const R53_MAX_PER_WINDOW = 3;
export const R53_WINDOW_MS = 14 * DAY_MS;
export const R53_LONG_MS = 12 * 3_600_000;
/** R16: anggapan panjang gulungan dan kertas per cetakan (struk dan tagihan); toleransi dan minimum gulungan terpakai. */
export const PAPER_ROLL_METERS = 25;
export const PAPER_DOC_CM = 15;
export const PAPER_TOLERANCE = 1.6;
export const PAPER_MIN_ROLLS = 3;

const rp = (n: number) => `Rp${Math.round(n).toLocaleString('id-ID')}`;

export interface IntegrityHit { rule: 'R15' | 'R16' | 'R50' | 'R51' | 'R52' | 'R53'; key: string; at: number; actors: string[]; note: string }

export interface ReceiptLine { ingredientId: string; name: string; qty: number; unitCost: number; poUnitCost: number }

/** R51: kelebihan nilai faktur di atas PO pada baris yang melewati toleransi 5%. Null bila tidak ada atau di bawah minimum. */
export function invoiceExcess(lines: ReceiptLine[]): { excess: number; detail: string } | null {
  const over = lines.filter((l) => l.unitCost > l.poUnitCost * (1 + R51_TOLERANCE) + 1e-9);
  const excess = over.reduce((s, l) => s + (l.unitCost - l.poUnitCost) * l.qty, 0);
  if (over.length === 0 || excess < R51_MIN_EXCESS) return null;
  return { excess, detail: over.map((l) => `${l.name} PO ${l.poUnitCost} → faktur ${l.unitCost} per satuan`).join('; ') };
}

/** R50: baris pembelian jauh lebih mahal dari harga terendah supplier lain (90 hari). Null bila wajar. */
export function priceOutlier(line: { qty: number; unitCost: number; name: string }, ownSupplier: string, otherMin: { supplierId: string; unitCost: number } | null): { excess: number; note: string } | null {
  if (!otherMin || otherMin.supplierId === ownSupplier) return null;
  if (line.unitCost <= otherMin.unitCost * (1 + R50_MARKUP) + 1e-9) return null;
  const excess = (line.unitCost - otherMin.unitCost) * line.qty;
  if (excess < R50_MIN_EXCESS) return null;
  return { excess, note: `${line.name} dibeli ${line.unitCost} per satuan dari ${ownSupplier}, sedangkan ${otherMin.supplierId} menjual ${otherMin.unitCost} (${Math.round((line.unitCost / otherMin.unitCost - 1) * 100)}% lebih mahal); kelebihan ${rp(excess)}` };
}

/** R15: selisih opname yang kurang, melewati toleransi 5% pemakaian, dan bernilai cukup. Mengembalikan nilainya bila memenuhi. */
export function shortageValue(m: { variance: number; periodUsed: number | null }, avgCost: number): number | null {
  if (m.variance >= 0) return null;
  const tol = Math.ceil((m.periodUsed ?? 0) * VARIANCE_TOLERANCE);
  if (Math.abs(m.variance) <= tol) return null;
  const value = Math.abs(m.variance) * avgCost;
  return value >= R15_MIN_VALUE ? value : null;
}

/** R52: apakah perubahan jumlah termasuk pengurangan yang berarti (≥ 20%, termasuk dihapus). */
export const isReduction = (before: number, after: number): boolean => before > 0 && after <= before * (1 - R52_REDUCTION) + 1e-9;

/** R16: pemakaian gulungan sebenarnya vs perkiraan dari cetakan tercatat. */
export function paperUsage(startRolls: number, endRolls: number, purchased: number, documents: number): { consumed: number; expected: number; flagged: boolean } {
  const consumed = startRolls + purchased - endRolls;
  const expected = (documents * PAPER_DOC_CM) / 100 / PAPER_ROLL_METERS;
  return { consumed, expected, flagged: consumed >= PAPER_MIN_ROLLS && consumed > expected * PAPER_TOLERANCE + 1 };
}

export interface Correction { id: number; staffId: string; staffName: string; startMs: number; endMs: number; createdBy: string }

/** R53: staf dengan terlalu banyak koreksi absen dalam jendela, dan koreksi yang sangat panjang. `emitFrom` membatasi hit pada kejadian baru. */
export function correctionHits(list: Correction[], emitFrom: number): IntegrityHit[] {
  const hits: IntegrityHit[] = [];
  const by = new Map<string, Correction[]>();
  for (const c of list) (by.get(c.staffId) ?? by.set(c.staffId, []).get(c.staffId)!).push(c);
  for (const [staff, rows] of by) {
    rows.sort((a, b) => a.startMs - b.startMs);
    // Satu temuan per staf per blok 14 hari (kunci stabil), memakai koreksi terakhir yang melewati batas; hitungannya ikut bertambah di catatan.
    let last: { cur: Correction; n: number } | null = null;
    rows.forEach((cur, i) => {
      const inWin = rows.slice(0, i + 1).filter((x) => x.startMs > cur.startMs - R53_WINDOW_MS);
      if (inWin.length > R53_MAX_PER_WINDOW && cur.endMs >= emitFrom) last = { cur, n: inWin.length };
    });
    if (last) {
      const { cur, n } = last as { cur: Correction; n: number };
      const recent = rows.filter((x) => x.startMs > cur.startMs - R53_WINDOW_MS && x.startMs <= cur.startMs);
      hits.push({ rule: 'R53', key: `R53:${staff}:${Math.floor(cur.startMs / R53_WINDOW_MS)}`, at: cur.endMs, actors: [...new Set([...recent.map((x) => x.createdBy), staff])], note: `${n} koreksi absen manual untuk ${cur.staffName} dalam ${Math.round(R53_WINDOW_MS / DAY_MS)} hari (dibuat oleh ${[...new Set(recent.map((x) => x.createdBy))].join(', ')})` });
    }
    for (const c of rows) {
      if (c.endMs < emitFrom || c.endMs - c.startMs < R53_LONG_MS) continue;
      hits.push({ rule: 'R53', key: `R53:long:${c.id}`, at: c.endMs, actors: [...new Set([c.createdBy, staff])], note: `koreksi absen manual ${Math.round((c.endMs - c.startMs) / 3_600_000)} jam untuk ${c.staffName} oleh ${c.createdBy}` });
    }
  }
  return hits;
}
