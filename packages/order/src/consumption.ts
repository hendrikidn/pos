import { correctedTime, type LineItem, type PosEvent } from '@pos/events';

/** Item yang dianggap sudah dibuat/dipakai dari satu order, dan kapan. */
export interface OrderConsumption {
  orderId: string;
  at: number;
  items: LineItem[];
}

const sumLines = (lists: LineItem[][]): LineItem[] => {
  const m = new Map<string, LineItem>();
  for (const l of lists.flat()) {
    const key = JSON.stringify([l.itemId, (l.options ?? []).map((o) => o.id ?? `${o.group}:${o.name}`).sort(), l.note ?? '']);
    const have = m.get(key);
    if (have) have.qty += l.qty;
    else m.set(key, { ...l });
  }
  return [...m.values()];
};

/**
 * Pemakaian bahan teoretis per order, dari event (dasar stok). Aturan:
 *  - Order yang masih draf (belum dikirim ke dapur dan belum ditagih) belum memakai bahan.
 *  - Order yang di-void memakai bahan hanya bila sudah dikirim ke dapur (makanan sudah dibuat): item yang dikirim, pada waktu kirim terakhir.
 *  - Selain itu memakai isi tagihan terakhir (`bill.printed.items`), pada waktu tagihan; tanpa tagihan, item yang dikirim ke dapur.
 *  - Makan karyawan MEMAKAI bahan (barangnya tetap keluar), walau bukan penjualan.
 *  - Order yang digabung ke order lain (MERGED) tidak memakai apa pun: itemnya sudah ada di tagihan order tujuan.
 * Event terminal lama tanpa rincian item tidak menghasilkan pemakaian.
 */
export function consumptionByOrder(events: PosEvent[]): OrderConsumption[] {
  // Buku besar item yang SUDAH terkirim ke dapur per order: kiriman ditambahkan, yang dipindah ke order lain (pisah bill) dikurangi di
  // asal dan ditambahkan di tujuan, yang digabung berpindah seluruhnya. Dipakai untuk order yang di-void atau belum ditagih.
  const sent = new Map<string, { at: number; lists: LineItem[][] }>();
  // `at` hanya naik: kapan item terkirim terakhir dimasak. Pemindahan tidak mengubah waktu masak; yang menerima mewarisi waktu asalnya.
  const ledger = (id: string, at?: number) => {
    const l = sent.get(id) ?? { at: at ?? 0, lists: [] };
    if (at !== undefined) l.at = Math.max(l.at, at);
    sent.set(id, l);
    return l;
  };
  const net = (id: string) => sumLines(sent.get(id)?.lists ?? []).filter((l) => l.qty > 0);
  const bill = new Map<string, { at: number; items: LineItem[] }>();
  const voided = new Set<string>();
  const merged = new Set<string>();
  const sorted = [...events].sort((a, b) => correctedTime(a) - correctedTime(b) || a.seq - b.seq);
  for (const e of sorted) {
    const t = correctedTime(e);
    switch (e.type) {
      case 'order.sent_to_kitchen':
        if (e.payload.items) ledger(e.payload.orderId, t).lists.push(e.payload.items);
        break;
      case 'bill.printed':
        if (e.payload.items) bill.set(e.payload.orderId, { at: t, items: e.payload.items });
        break;
      case 'void.approved': voided.add(e.payload.orderId); break;
      case 'order.items_moved': {
        const p = e.payload;
        if (p.kind === 'MERGE') {
          const items = net(p.fromOrderId);
          if (items.length > 0) {
            ledger(p.toOrderId, sent.get(p.fromOrderId)?.at ?? t).lists.push(items);
            ledger(p.fromOrderId).lists.push(items.map((l) => ({ ...l, qty: -l.qty })));
          }
          merged.add(p.fromOrderId);
        } else {
          const out = p.items.filter((l) => (l.sentQty ?? 0) > 0).map((l) => ({ ...l, qty: l.sentQty! }));
          if (out.length > 0) {
            ledger(p.toOrderId, sent.get(p.fromOrderId)?.at ?? t).lists.push(out);
            ledger(p.fromOrderId).lists.push(out.map((l) => ({ ...l, qty: -l.qty })));
          }
        }
        break;
      }
      default: break;
    }
  }
  const out: OrderConsumption[] = [];
  const ids = new Set([...sent.keys(), ...bill.keys()]);
  for (const id of ids) {
    if (merged.has(id)) continue;
    const b = bill.get(id);
    const items = net(id);
    if (voided.has(id)) {
      if (items.length > 0) out.push({ orderId: id, at: sent.get(id)!.at, items });
    } else if (b) out.push({ orderId: id, at: b.at, items: b.items });
    else if (items.length > 0) out.push({ orderId: id, at: sent.get(id)!.at, items });
  }
  return out.sort((a, b) => a.at - b.at || a.orderId.localeCompare(b.orderId));
}

/** Resep: bahan per porsi menu, dan tambahan per opsi menu itu. Kunci opsi = `${menuId}|${optionId}`. */
export interface Recipes {
  base: Map<string, Map<string, number>>;
  options: Map<string, Map<string, number>>;
}

/** Pemakaian bahan (satuan terkecil) dari sekumpulan order dalam rentang waktu (from, to]. */
export function usageByIngredient(consumption: OrderConsumption[], recipes: Recipes, fromMs: number, toMs: number): Map<string, number> {
  const used = new Map<string, number>();
  const add = (lines: Map<string, number> | undefined, qty: number) => {
    if (!lines) return;
    for (const [ing, per] of lines) used.set(ing, (used.get(ing) ?? 0) + per * qty);
  };
  for (const c of consumption) {
    if (c.at <= fromMs || c.at > toMs) continue;
    for (const l of c.items) {
      add(recipes.base.get(l.itemId), l.qty);
      for (const o of l.options ?? []) if (o.id) add(recipes.options.get(`${l.itemId}|${o.id}`), l.qty);
    }
  }
  return used;
}
