import type { Queryable } from './db/driver';
import {
  correctionHits, DAY_MS, invoiceExcess, isReduction, paperUsage, PAPER_DOC_CM, PAPER_ROLL_METERS, priceOutlier, R50_REFERENCE_DAYS, R52_LOOKBACK_MS, shortageValue,
  type Correction, type IntegrityHit, type ReceiptLine,
} from './integrity';

const num = (v: unknown) => Number(v);
const rp = (n: number) => `Rp${Math.round(n).toLocaleString('id-ID')}`;

/** Temuan integritas satu outlet sejak `from` (R15, R16, R50, R51, R52, R53). Semua murni dari data server, jadi bisa dihitung ulang kapan saja. */
export async function integrityHits(q: Queryable, outletId: string, from: number, now: number): Promise<IntegrityHit[]> {
  const hits: IntegrityHit[] = [];

  // R51 dan R50: penerimaan barang di jendela.
  const lines = (await q.query<{ id: string; at: number; by: string; supplier: string; ingredient_id: string; name: string; qty: number; unit_cost: string; po_unit_cost: string; line_no: number; price_flag: boolean }>(
    `select r.id, r.received_at_ms as at, r.received_by as by, r.supplier_id as supplier, l.ingredient_id, i.name, l.qty, l.unit_cost, l.po_unit_cost, l.line_no, r.price_flag
     from purchase_receipt r join purchase_receipt_line l on l.receipt_id = r.id join ingredient i on i.tenant_id = l.tenant_id and i.id = l.ingredient_id
     where r.outlet_id = $1 and r.received_at_ms >= $2`, [outletId, from],
  )).rows;
  const byReceipt = new Map<string, typeof lines>();
  for (const l of lines) (byReceipt.get(l.id) ?? byReceipt.set(l.id, []).get(l.id)!).push(l);
  for (const [id, rows] of byReceipt) {
    const first = rows[0]!;
    const ex = invoiceExcess(rows.map((l): ReceiptLine => ({ ingredientId: l.ingredient_id, name: l.name, qty: l.qty, unitCost: num(l.unit_cost), poUnitCost: num(l.po_unit_cost) })));
    if (ex) hits.push({ rule: 'R51', key: `R51:${id}`, at: num(first.at), actors: [first.by], note: `faktur penerimaan #${id} (${first.supplier}) melebihi harga PO sebesar ${rp(ex.excess)}: ${ex.detail}` });
  }
  if (lines.length > 0) {
    const ref = (await q.query<{ ingredient_id: string; supplier_id: string; m: string }>(
      `select l.ingredient_id, r.supplier_id, min(l.unit_cost) as m from purchase_receipt_line l join purchase_receipt r on r.id = l.receipt_id
       where r.received_at_ms >= $1 and r.received_at_ms <= $2 and l.ingredient_id = any($3::text[]) group by l.ingredient_id, r.supplier_id`,
      [now - R50_REFERENCE_DAYS * DAY_MS, now, [...new Set(lines.map((l) => l.ingredient_id))]],
    )).rows;
    for (const l of lines) {
      const others = ref.filter((r) => r.ingredient_id === l.ingredient_id && r.supplier_id !== l.supplier);
      const min = others.length === 0 ? null : others.reduce((a, b) => (num(b.m) < num(a.m) ? b : a));
      const out = priceOutlier({ qty: l.qty, unitCost: num(l.unit_cost), name: l.name }, l.supplier, min ? { supplierId: min.supplier_id, unitCost: num(min.m) } : null);
      if (out) hits.push({ rule: 'R50', key: `R50:${l.id}:${l.line_no}`, at: num(l.at), actors: [l.by], note: `penerimaan #${l.id}: ${out.note}` });
    }
  }

  // R15: selisih opname yang kurang dan bernilai.
  const counts = (await q.query<{ id: string; name: string; unit: string; avg_cost: string; variance: number; period_used: number | null; user_id: string; at_ms: number }>(
    `select m.id, i.name, i.unit, i.avg_cost, m.variance, m.period_used, m.user_id, m.at_ms from stock_movement m join ingredient i on i.tenant_id = m.tenant_id and i.id = m.ingredient_id
     where m.outlet_id = $1 and m.kind = 'COUNT' and m.at_ms >= $2 and m.variance < 0`, [outletId, from],
  )).rows;
  for (const c of counts) {
    const v = shortageValue({ variance: c.variance, periodUsed: c.period_used }, num(c.avg_cost));
    if (v !== null) hits.push({ rule: 'R15', key: `R15:${c.id}`, at: num(c.at_ms), actors: [c.user_id], note: `${c.name} kurang ${Math.abs(c.variance).toLocaleString('id-ID')} ${c.unit} dari pemakaian menurut resep (${(c.period_used ?? 0).toLocaleString('id-ID')} ${c.unit}), senilai ${rp(v)}` });
  }

  // R52: resep atau BOM dikurangi tak lama setelah selisih opname yang kurang pada bahan yang sama.
  const changes = (await q.query<{ id: string; kind: string; target_id: string; ingredient_id: string; name: string; before_qty: number; after_qty: number; user_id: string; at_ms: number; variance: number; period_used: number | null }>(
    `select rc.id, rc.kind, rc.target_id, rc.ingredient_id, i.name, rc.before_qty, rc.after_qty, rc.user_id, rc.at_ms, m.variance, m.period_used
     from recipe_change rc join ingredient i on i.tenant_id = rc.tenant_id and i.id = rc.ingredient_id
     join stock_movement m on m.tenant_id = rc.tenant_id and m.ingredient_id = rc.ingredient_id and m.outlet_id = $1 and m.kind = 'COUNT' and m.variance < 0 and m.at_ms <= rc.at_ms and m.at_ms >= rc.at_ms - $3
     where rc.at_ms >= $2 and rc.before_qty > 0 order by rc.at_ms, rc.id, m.at_ms desc`, [outletId, from, R52_LOOKBACK_MS],
  )).rows;
  const seen = new Set<string>();
  for (const c of changes) {
    if (seen.has(c.id) || !isReduction(c.before_qty, c.after_qty)) continue;
    const flagged = Math.abs(c.variance) > Math.ceil((c.period_used ?? 0) * 0.05);
    if (!flagged) continue;
    seen.add(c.id);
    hits.push({ rule: 'R52', key: `R52:${c.id}`, at: num(c.at_ms), actors: [c.user_id], note: `${c.kind === 'BOM' ? 'BOM' : 'resep'} ${c.target_id}: ${c.name} dikurangi dari ${c.before_qty} menjadi ${c.after_qty} per ${c.kind === 'BOM' ? 'batch' : 'porsi'} setelah opname menemukan ${c.name} kurang ${Math.abs(c.variance).toLocaleString('id-ID')}` });
  }

  // R53: koreksi absen berulang atau sangat panjang.
  const corrections = (await q.query<{ id: string; staff_id: string; name: string; start_ms: number; end_ms: number; created_by: string }>(
    `select a.id, a.staff_id, s.name, a.start_ms, a.end_ms, a.created_by from attendance_adjust a join staff s on s.tenant_id = a.tenant_id and s.id = a.staff_id
     where a.outlet_id = $1 and a.voided_at is null and a.end_ms >= $2`, [outletId, from - 14 * DAY_MS],
  )).rows.map((r): Correction => ({ id: num(r.id), staffId: r.staff_id, staffName: r.name, startMs: num(r.start_ms), endMs: num(r.end_ms), createdBy: r.created_by }));
  hits.push(...correctionHits(corrections, from));

  // R16: pemakaian gulungan kertas vs cetakan tercatat, antara dua hitung sisa berurutan.
  const paper = (await q.query<{ kind: 'PURCHASE' | 'COUNT'; rolls: number; user_id: string; at_ms: number; id: string }>(
    'select id, kind, rolls, user_id, at_ms from paper_roll_log where outlet_id = $1 order by at_ms, id', [outletId],
  )).rows;
  const cs = paper.filter((p) => p.kind === 'COUNT');
  for (let i = 1; i < cs.length; i++) {
    const a = cs[i - 1]!;
    const b = cs[i]!;
    if (num(b.at_ms) < from) continue;
    const purchased = paper.filter((p) => p.kind === 'PURCHASE' && num(p.at_ms) > num(a.at_ms) && num(p.at_ms) <= num(b.at_ms)).reduce((s, p) => s + p.rolls, 0);
    const docs = num((await q.query<{ n: string }>("select count(*) as n from event where outlet_id = $1 and type in ('bill.printed', 'receipt.printed') and device_time_ms > $2 and device_time_ms <= $3", [outletId, a.at_ms, b.at_ms])).rows[0]!.n);
    const u = paperUsage(a.rolls, b.rolls, purchased, docs);
    if (u.flagged) hits.push({ rule: 'R16', key: `R16:${b.id}`, at: num(b.at_ms), actors: [b.user_id], note: `${u.consumed} gulungan terpakai, padahal ${docs} cetakan tercatat hanya butuh sekitar ${u.expected.toFixed(1)} gulungan (anggapan ${PAPER_DOC_CM} cm per cetakan, ${PAPER_ROLL_METERS} m per gulungan)` });
  }
  return hits;
}
