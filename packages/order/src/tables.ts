import { correctedTime, type KitchenStatus, type PosEvent } from '@pos/events';
import { reduceOrder, type OrderState } from './index';

/** Order yang tidak tersentuh lebih lama dari ini dianggap sisa (mis. draft yang ditinggalkan) dan tidak menahan meja. */
export const TABLE_ORDER_MAX_IDLE_MS = 12 * 3_600_000;

export interface TableDef {
  /** Nomor atau nama meja seperti yang diketik/dipilih kasir (maks. 10 karakter). */
  no: string;
  area: string;
  seats: number;
}

/** Order dine-in yang masih terbuka di satu meja, menurut event dari semua terminal. */
export interface TableOrderView {
  orderId: string;
  deviceId: string;
  tableNo: string;
  status: 'DRAFT' | 'SENT' | 'BILLED';
  /** Kapan order dibuat (jam yang sudah dikoreksi). */
  since: number;
  /** Total tagihan; hanya ada setelah bill dicetak. */
  total: number | null;
  paid: number;
  kitchen: KitchenStatus | null;
}

export interface TableBoard {
  generatedAt: number;
  orders: TableOrderView[];
}

interface Acc {
  state: OrderState;
  deviceId: string;
  tableNo: string | null;
  since: number;
  lastAt: number;
}

/**
 * Order dine-in terbuka per meja dari event POS. Murni: dipakai server (papan meja untuk semua terminal) dan pengujian.
 * Meja dipakai sejak `order.created` sampai order lunas, di-void, atau digabung; pindah meja mengikuti `order.table_changed`.
 */
export function buildTableBoard(input: { events: PosEvent[]; now: number }): TableBoard {
  const { now } = input;
  const events = [...input.events].sort((a, b) => correctedTime(a) - correctedTime(b) || a.deviceId.localeCompare(b.deviceId) || a.seq - b.seq);
  const acc = new Map<string, Acc>();
  for (const e of events) {
    const t = correctedTime(e);
    if (e.type === 'order.created') {
      const state = reduceOrder(undefined, e)!;
      acc.set(e.payload.orderId, { state, deviceId: e.deviceId, tableNo: e.payload.tableNo ?? null, since: t, lastAt: t });
      continue;
    }
    if (e.type === 'order.items_moved') {
      for (const id of [e.payload.fromOrderId, e.payload.toOrderId]) {
        const a = acc.get(id);
        if (!a) continue;
        a.state = reduceOrder(a.state, e) ?? a.state;
        a.lastAt = t;
      }
      continue;
    }
    const id = (e.payload as { orderId?: string } | undefined)?.orderId;
    const a = id ? acc.get(id) : undefined;
    if (!a) continue;
    if (e.type === 'order.table_changed') a.tableNo = e.payload.to;
    a.state = reduceOrder(a.state, e) ?? a.state;
    a.lastAt = t;
  }
  const orders: TableOrderView[] = [];
  for (const [orderId, a] of acc) {
    const s = a.state;
    if (a.tableNo === null || s.orderType !== 'DINE_IN') continue;
    if (s.status !== 'DRAFT' && s.status !== 'SENT' && s.status !== 'BILLED') continue;
    if (now - a.lastAt > TABLE_ORDER_MAX_IDLE_MS) continue;
    orders.push({ orderId, deviceId: a.deviceId, tableNo: a.tableNo, status: s.status, since: a.since, total: s.total, paid: s.paid, kitchen: s.kitchen });
  }
  orders.sort((x, y) => x.since - y.since || x.orderId.localeCompare(y.orderId));
  return { generatedAt: now, orders };
}

/** FREE: kosong. OCCUPIED: ada order, belum ke dapur. SENT: sedang diproses dapur. BILLED: bill sudah dicetak, menunggu pembayaran. */
export type TableState = 'FREE' | 'OCCUPIED' | 'SENT' | 'BILLED';

export interface TableSummary {
  no: string;
  state: TableState;
  orders: TableOrderView[];
  since: number | null;
  /** Total semua bill yang sudah dicetak di meja ini, dikurangi yang sudah dibayar. */
  due: number;
}

const RANK: Record<TableState, number> = { FREE: 0, OCCUPIED: 1, SENT: 2, BILLED: 3 };

/** Ringkasan satu meja dari order terbukanya. Meja dengan beberapa order (pisah bill) berstatus yang paling maju. */
export function summarizeTable(no: string, orders: TableOrderView[]): TableSummary {
  const mine = orders.filter((o) => o.tableNo === no);
  let state: TableState = 'FREE';
  for (const o of mine) {
    const s: TableState = o.status === 'DRAFT' ? 'OCCUPIED' : o.status === 'SENT' ? 'SENT' : 'BILLED';
    if (RANK[s] > RANK[state]) state = s;
  }
  return {
    no, state, orders: mine,
    since: mine.length ? Math.min(...mine.map((o) => o.since)) : null,
    due: mine.reduce((s, o) => s + (o.total === null ? 0 : Math.max(0, o.total - o.paid)), 0),
  };
}

/**
 * Daftar nomor meja dari teks: dipisah koma atau spasi, rentang angka ditulis "1-8". Mengembalikan null bila ada bagian yang
 * tidak valid atau hasilnya lebih dari 200 meja. Urutan ketikan dipertahankan; nomor kembar dibuang.
 */
export function parseTableList(text: string): string[] | null {
  const out: string[] = [];
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const range = /^(\d{1,4})-(\d{1,4})$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (b < a || b - a > 199) return null;
      for (let n = a; n <= b; n++) out.push(String(n));
    } else if (/^[A-Za-z0-9._-]{1,10}$/.test(part)) out.push(part);
    else return null;
  }
  const uniq = [...new Set(out)];
  return uniq.length > 200 ? null : uniq;
}

/** Kebalikan `parseTableList`: angka berurutan (3 atau lebih) diringkas menjadi rentang. */
export function formatTableList(nos: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < nos.length; ) {
    const isNum = (s: string | undefined) => s !== undefined && /^\d{1,4}$/.test(s);
    let j = i;
    if (isNum(nos[i])) while (isNum(nos[j + 1]) && Number(nos[j + 1]) === Number(nos[j]) + 1) j++;
    if (j - i >= 2) {
      parts.push(`${nos[i]}-${nos[j]}`);
      i = j + 1;
    } else parts.push(nos[i]!), i++;
  }
  return parts.join(', ');
}
