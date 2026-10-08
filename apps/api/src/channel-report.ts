import { correctedTime, type EventOf, type OnlineChannel, type PosEvent } from '@pos/events';
import type { RuleHit } from '@pos/rules';
import { parsePrice, splitCsv } from './menu-import';
import { localDate } from './sales-report';

/** Laporan pesanan dari platform pesan-antar (GoFood, GrabFood, ShopeeFood) dalam CSV, untuk dicocokkan dengan order online di POS. */

export const CHANNEL_REPORT_MAX_ROWS = 5000;
export const CHANNEL_REPORT_MAX_BYTES = 1024 * 1024;

export interface PlatformRow {
  line: number;
  ref: string;
  /** Tanggal pesanan (YYYY-MM-DD) menurut laporan platform. */
  date: string;
  gross: number;
  commission: number;
  net: number;
}

export interface ParsedChannelReport {
  rows: PlatformRow[];
  errors: { line: number; message: string }[];
}

const COLS = {
  ref: ['order id', 'order_id', 'orderid', 'no pesanan', 'nomor pesanan', 'id pesanan', 'kode pesanan', 'order no', 'order number', 'ref', 'no. pesanan', 'nomor order'],
  date: ['tanggal', 'date', 'tanggal pesanan', 'order date', 'waktu', 'waktu pesanan', 'tanggal order', 'created at'],
  gross: ['harga', 'total', 'gross', 'subtotal', 'nilai pesanan', 'food price', 'harga makanan', 'penjualan', 'gross amount', 'total pesanan', 'jumlah'],
  commission: ['komisi', 'commission', 'biaya layanan', 'fee', 'potongan', 'biaya komisi', 'platform fee'],
  net: ['diterima', 'net', 'payout', 'pendapatan bersih', 'nett', 'net amount', 'dana diterima', 'penghasilan bersih', 'net payout'],
} as const;

/** Tanggal dari YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, atau DD Mon YYYY (bulan Indonesia/Inggris), boleh diikuti jam; null bila tidak dikenali. */
export function parseReportDate(raw: string): string | null {
  const s = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, agu: 8, aug: 8, ags: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12 };
  const named = /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})/.exec(s);
  let y: number; let m: number; let d: number;
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (dmy) [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  else if (named && MONTHS[named[2]!.toLowerCase()]) [d, m, y] = [Number(named[1]), MONTHS[named[2]!.toLowerCase()]!, Number(named[3])];
  else return null;
  const out = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = Date.parse(`${out}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === out ? out : null;
}

export function parseChannelReport(textRaw: string): ParsedChannelReport {
  const text = textRaw.replace(/^﻿/, '');
  if (text.trim() === '') return { rows: [], errors: [{ line: 1, message: 'berkas kosong' }] };
  if (Buffer.byteLength(text) > CHANNEL_REPORT_MAX_BYTES) return { rows: [], errors: [{ line: 1, message: `berkas lebih dari ${CHANNEL_REPORT_MAX_BYTES / 1024} KB` }] };
  const head = text.split(/\r?\n/, 1)[0]!.replace(/"[^"]*"/g, '');
  const delimiter = ([',', ';', '\t'] as const).map((d) => [d, head.split(d).length - 1] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const records = splitCsv(text, delimiter).map((r, i) => ({ r, line: i + 1 })).filter((x) => x.r.some((c) => c.trim() !== ''));
  const header = records[0]!.r.map((h) => h.trim().toLowerCase());
  const find = (names: readonly string[]) => header.findIndex((h) => names.includes(h));
  const col = { ref: find(COLS.ref), date: find(COLS.date), gross: find(COLS.gross), commission: find(COLS.commission), net: find(COLS.net) };
  const errors: { line: number; message: string }[] = [];
  if (col.ref < 0) errors.push({ line: 1, message: 'kolom nomor pesanan tidak ditemukan (mis. "Order ID" atau "No Pesanan")' });
  if (col.date < 0) errors.push({ line: 1, message: 'kolom tanggal tidak ditemukan' });
  if (col.gross < 0 && col.net < 0) errors.push({ line: 1, message: 'kolom nilai pesanan tidak ditemukan (mis. "Harga" atau "Total")' });
  if (errors.length > 0) return { rows: [], errors };
  const body = records.slice(1);
  if (body.length === 0) return { rows: [], errors: [{ line: 2, message: 'tidak ada baris pesanan' }] };
  if (body.length > CHANNEL_REPORT_MAX_ROWS) return { rows: [], errors: [{ line: 1, message: `maksimal ${CHANNEL_REPORT_MAX_ROWS} baris per laporan` }] };

  const rows: PlatformRow[] = [];
  const seen = new Map<string, number>();
  for (const { r, line } of body) {
    const cell = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
    const ref = cell(col.ref);
    const date = parseReportDate(cell(col.date));
    const grossRaw = col.gross >= 0 ? parsePrice(cell(col.gross)) : null;
    const commRaw = col.commission >= 0 && cell(col.commission) !== '' ? parsePrice(cell(col.commission).replace(/^-/, '')) : 0;
    const netRaw = col.net >= 0 && cell(col.net) !== '' ? parsePrice(cell(col.net)) : null;
    if (!/^[A-Za-z0-9._-]{3,30}$/.test(ref)) { errors.push({ line, message: `nomor pesanan "${ref}" tidak valid` }); continue; }
    if (!date) { errors.push({ line, message: `tanggal "${cell(col.date)}" tidak dikenali (pakai YYYY-MM-DD atau DD/MM/YYYY)` }); continue; }
    if (commRaw === null) { errors.push({ line, message: `komisi "${cell(col.commission)}" tidak valid` }); continue; }
    if (grossRaw === null && netRaw === null) { errors.push({ line, message: `nilai pesanan "${cell(col.gross)}" tidak valid` }); continue; }
    const gross = grossRaw ?? (netRaw! + commRaw);
    const net = netRaw ?? Math.max(0, gross - commRaw);
    const key = ref.toLowerCase();
    if (seen.has(key)) { errors.push({ line, message: `nomor pesanan ${ref} kembar dengan baris ${seen.get(key)}` }); continue; }
    seen.set(key, line);
    rows.push({ line, ref, date, gross, commission: commRaw, net });
  }
  return { rows, errors };
}

// ---------- rekonsiliasi dengan order online di POS ----------

export interface PosOnlineOrder {
  orderId: string;
  channel: OnlineChannel;
  ref: string;
  /** Hari pembayaran (tanggal lokal outlet). */
  date: string;
  /** Nilai makanan menurut POS (subtotal tagihan; total bila rincian tidak ada). */
  amount: number;
  terminalId: string;
  actorId: string | null;
  at: number;
}

/** Order online yang dibayar Platform dari event POS, tidak termasuk yang di-void. */
export function posOnlineOrders(events: PosEvent[], offsetMinutes: number): PosOnlineOrder[] {
  const links = new Map<string, EventOf<'order.channel_linked'>>();
  const voided = new Set<string>();
  const bills = new Map<string, EventOf<'bill.printed'>>();
  const pays = new Map<string, EventOf<'payment.received'>[]>();
  for (const e of [...events].sort((a, b) => correctedTime(a) - correctedTime(b) || a.seq - b.seq)) {
    if (e.type === 'order.channel_linked' && !links.has(e.payload.orderId)) links.set(e.payload.orderId, e);
    else if (e.type === 'void.approved') voided.add(e.payload.orderId);
    else if (e.type === 'bill.printed') bills.set(e.payload.orderId, e);
    else if (e.type === 'payment.received' && e.payload.method === 'PLATFORM') (pays.get(e.payload.orderId) ?? pays.set(e.payload.orderId, []).get(e.payload.orderId)!).push(e);
  }
  const out: PosOnlineOrder[] = [];
  for (const [orderId, link] of links) {
    const p = pays.get(orderId);
    if (!p || voided.has(orderId)) continue;
    const b = bills.get(orderId)?.payload;
    out.push({
      orderId, channel: link.payload.channel, ref: link.payload.ref, date: localDate(correctedTime(p[0]!), offsetMinutes),
      amount: b?.breakdown ? b.breakdown.subtotal : (b?.total ?? p.reduce((s, x) => s + x.payload.amount, 0)), terminalId: link.deviceId, actorId: link.actorId, at: correctedTime(p[0]!),
    });
  }
  return out.sort((a, b) => a.at - b.at || a.orderId.localeCompare(b.orderId));
}

export interface ChannelFinding {
  kind: 'MISSING_ON_PLATFORM' | 'AMOUNT_MISMATCH' | 'UNRECORDED_IN_POS';
  channel: OnlineChannel;
  ref: string;
  orderId: string | null;
  at: number;
  terminalId: string | null;
  actorId: string | null;
  note: string;
}

/** Selisih nilai yang wajar antara POS dan platform (pembulatan, biaya kemasan): Rp 1.000 atau 1,5%, mana yang lebih besar. */
export const amountTolerance = (v: number): number => Math.max(1_000, Math.round(v * 0.015));

/**
 * Mencocokkan order online POS dengan baris laporan platform per kanal. Hanya hari yang tercakup laporan (tanggal terawal sampai terakhir
 * baris laporan kanal itu) yang diperiksa, supaya pesanan yang belum masuk laporan tidak dituduh hilang.
 *  - MISSING_ON_PLATFORM: ada di POS (dibayar "Platform") tetapi tidak ada di laporan platform: pesanan fiktif untuk menyembunyikan uang tunai.
 *  - AMOUNT_MISMATCH: ada di keduanya tetapi nilainya berbeda lebih dari toleransi.
 *  - UNRECORDED_IN_POS: dibayar platform tetapi tidak ada di POS: penjualan tidak diketik (stok dan laporan penjualan jadi kurang).
 */
export function reconcileChannel(input: {
  orders: PosOnlineOrder[];
  rows: { channel: OnlineChannel; row: PlatformRow }[];
  /** Hanya order/baris pada tanggal ≥ ini yang diperiksa (batas data event yang tersedia). */
  fromDate: string;
  nowMs: number;
}): ChannelFinding[] {
  const findings: ChannelFinding[] = [];
  const channels = new Set(input.rows.map((r) => r.channel));
  for (const channel of channels) {
    const rows = input.rows.filter((r) => r.channel === channel).map((r) => r.row);
    const dates = rows.map((r) => r.date).sort();
    const [lo, hi] = [dates[0]!, dates[dates.length - 1]!];
    const byRef = new Map(rows.map((r) => [r.ref.toLowerCase(), r]));
    // Nomor yang dipakai dua order: yang pertama dianggap pasangan platform; yang berikutnya ditangani R36.
    const posByRef = new Map<string, PosOnlineOrder>();
    for (const o of input.orders.filter((x) => x.channel === channel)) if (!posByRef.has(o.ref.toLowerCase())) posByRef.set(o.ref.toLowerCase(), o);
    for (const o of posByRef.values()) {
      if (o.date < input.fromDate || o.date < lo || o.date > hi) continue;
      const r = byRef.get(o.ref.toLowerCase());
      if (!r) {
        findings.push({ kind: 'MISSING_ON_PLATFORM', channel, ref: o.ref, orderId: o.orderId, at: o.at, terminalId: o.terminalId, actorId: o.actorId, note: `pesanan ${channel} ${o.ref} (Rp ${o.amount.toLocaleString('id-ID')}) dibayar "Platform" di POS tetapi tidak ada di laporan platform ${lo} s/d ${hi}` });
      } else if (Math.abs(r.gross - o.amount) > amountTolerance(r.gross)) {
        findings.push({ kind: 'AMOUNT_MISMATCH', channel, ref: o.ref, orderId: o.orderId, at: o.at, terminalId: o.terminalId, actorId: o.actorId, note: `pesanan ${channel} ${o.ref}: POS Rp ${o.amount.toLocaleString('id-ID')}, platform Rp ${r.gross.toLocaleString('id-ID')}` });
      }
    }
    for (const r of rows) {
      if (r.date < input.fromDate || posByRef.has(r.ref.toLowerCase())) continue;
      findings.push({ kind: 'UNRECORDED_IN_POS', channel, ref: r.ref, orderId: null, at: Date.parse(`${r.date}T12:00:00Z`), terminalId: null, actorId: null, note: `pesanan ${channel} ${r.ref} (Rp ${r.gross.toLocaleString('id-ID')}, ${r.date}) dibayar platform tetapi tidak ada di POS` });
    }
  }
  return findings.sort((a, b) => a.at - b.at || a.ref.localeCompare(b.ref));
}

const WEIGHT = { MISSING_ON_PLATFORM: 50, AMOUNT_MISMATCH: 35, UNRECORDED_IN_POS: 25 } as const;
const RULE = { MISSING_ON_PLATFORM: 'R37', AMOUNT_MISMATCH: 'R38', UNRECORDED_IN_POS: 'R39' } as const;

export function findingToHit(f: ChannelFinding, outletId: string): RuleHit {
  return {
    rule: RULE[f.kind], key: `${RULE[f.kind]}:${f.channel}:${f.ref.toLowerCase()}`, weight: WEIGHT[f.kind], modalities: ['POS'], outletId,
    terminalId: f.terminalId, orderId: f.orderId, actorIds: f.actorId ? [f.actorId] : [], at: f.at, windowStart: f.at, windowEnd: f.at,
    context: false, confidence: f.kind === 'AMOUNT_MISMATCH' ? 'LOW' : 'HIGH', note: f.note,
  };
}
