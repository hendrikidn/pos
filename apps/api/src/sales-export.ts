import { correctedTime, type EventOf, type PosEvent } from '@pos/events';
import { addDays, DAY_MS, localDate, type SalesReportInput } from './sales-report';

export const EXPORT_KINDS = ['transactions', 'payments', 'items', 'exceptions', 'daily'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** Jenis event yang dibutuhkan ekspor (lebih banyak daripada laporan ringkas: meja dan member ikut). */
export const EXPORT_EVENT_TYPES = [
  'payment.received', 'refund.created', 'discount.applied', 'order.created', 'order.table_changed', 'order.member_linked', 'bill.printed',
];

export interface ExportTable {
  /** Akhiran nama berkas, mis. "transaksi". */
  slug: string;
  header: string[];
  rows: (string | number)[][];
}

const METHOD = { CASH: 'Tunai', QRIS: 'QRIS', EDC_DEBIT: 'Kartu debit', EDC_CREDIT: 'Kartu kredit' } as const;
const TYPE = { DINE_IN: 'Dine-in', TAKE_AWAY: 'Take-away', EMPLOYEE: 'Karyawan' } as const;

/**
 * Sel CSV yang aman: nilai yang diawali = + - @ tab atau CR dibuat teks biasa dengan apostrof di depan, supaya Excel/Sheets tidak menjalankannya
 * sebagai rumus (nama menu, catatan kasir, dan nama member berasal dari input pengguna). Angka tidak disentuh.
 */
export function csvCell(v: string | number): string {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV UTF-8 dengan BOM (agar Excel membaca huruf dan simbol dengan benar) dan akhiran baris CRLF. */
export function toCsv(table: Pick<ExportTable, 'header' | 'rows'>): string {
  return `﻿${[table.header, ...table.rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Tanggal dan jam lokal outlet dari epoch ms. */
function localStamp(ms: number, off: number): { date: string; time: string } {
  const d = new Date(ms + off * 60_000);
  return { date: d.toISOString().slice(0, 10), time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` };
}

interface OrderInfo {
  type: string;
  table: string;
  creator: string;
  terminal: string;
  member: string;
}

/**
 * Tabel ekspor dari event POS, memakai aturan hitung yang sama dengan laporan penjualan (order karyawan dan order yang di-void tidak dihitung
 * sebagai penjualan; satu order dihitung pada pembayaran pertamanya di rentang). Murni.
 */
export function buildExport(kind: ExportKind, input: SalesReportInput): ExportTable {
  const { fromMs, toMs, utcOffsetMinutes: off, now } = input;
  const t = correctedTime;
  const events = input.events.filter((e) => t(e) <= now + DAY_MS);
  const inRange = (e: PosEvent) => t(e) >= fromMs && t(e) < toMs;
  const sorted = [...events].sort((a, b) => t(a) - t(b) || a.deviceId.localeCompare(b.deviceId) || a.seq - b.seq);

  const info = new Map<string, OrderInfo>();
  const get = (id: string): OrderInfo => {
    let o = info.get(id);
    if (!o) info.set(id, (o = { type: '', table: '', creator: '', terminal: '', member: '' }));
    return o;
  };
  const voided = new Map<string, EventOf<'void.approved'>>();
  const bill = new Map<string, EventOf<'bill.printed'>>();
  const payments = new Map<string, EventOf<'payment.received'>[]>();
  const discounts = new Map<string, EventOf<'discount.applied'>[]>();
  for (const e of sorted) {
    switch (e.type) {
      case 'order.created': {
        const o = get(e.payload.orderId);
        o.type = e.payload.orderType;
        o.creator = e.actorId ?? '';
        o.terminal = e.deviceId;
        if (e.payload.tableNo) o.table = e.payload.tableNo;
        break;
      }
      case 'order.table_changed': get(e.payload.orderId).table = e.payload.to; break;
      case 'order.member_linked': get(e.payload.orderId).member = e.payload.memberId; break;
      case 'bill.printed': bill.set(e.payload.orderId, e); break;
      case 'void.approved': if (!voided.has(e.payload.orderId)) voided.set(e.payload.orderId, e); break;
      case 'payment.received': (payments.get(e.payload.orderId) ?? payments.set(e.payload.orderId, []).get(e.payload.orderId)!).push(e); break;
      case 'discount.applied': (discounts.get(e.payload.orderId) ?? discounts.set(e.payload.orderId, []).get(e.payload.orderId)!).push(e); break;
      default: break;
    }
  }
  const counts = (id: string) => info.get(id)?.type !== 'EMPLOYEE' && !voided.has(id);
  /** Order terhitung, urut waktu pembayaran pertama di rentang. */
  const counted: { id: string; first: EventOf<'payment.received'> }[] = [];
  for (const [id, list] of payments) {
    const first = list.find(inRange);
    if (first && counts(id)) counted.push({ id, first });
  }
  counted.sort((a, b) => t(a.first) - t(b.first) || a.id.localeCompare(b.id));
  const methodsOf = (id: string) => [...new Set((payments.get(id) ?? []).map((p) => METHOD[p.payload.method]))].join(' + ');

  switch (kind) {
    case 'transactions': {
      const rows = counted.map(({ id, first }) => {
        const o = info.get(id) ?? { type: '', table: '', creator: '', terminal: '', member: '' };
        const b = bill.get(id)?.payload;
        const bd = b?.breakdown;
        const ds = discounts.get(id) ?? [];
        const stamp = localStamp(t(first), off);
        const paid = (payments.get(id) ?? []).reduce((s, p) => s + p.payload.amount, 0);
        return [
          stamp.date, stamp.time, id, TYPE[o.type as keyof typeof TYPE] ?? o.type, o.table, first.actorId ?? o.creator, o.terminal,
          bd ? bd.subtotal : '', bd ? bd.discount : (ds.reduce((s, d) => s + d.payload.amount, 0) || ''), bd ? bd.service : '', bd ? bd.tax : '', bd ? bd.rounding : '',
          b ? b.total : '', paid, methodsOf(id),
          ds.map((d) => (d.payload.kind === 'PROMO' ? `Promo ${d.payload.promoId}` : d.payload.kind === 'POINTS' ? `Poin ${d.payload.points}` : d.payload.kind)).join(' + '), o.member,
        ];
      });
      return {
        slug: 'transaksi',
        header: ['Tanggal', 'Jam', 'Order', 'Jenis', 'Meja', 'Kasir', 'Terminal', 'Subtotal', 'Diskon', 'Service', 'Pajak', 'Pembulatan', 'Total tagihan', 'Dibayar', 'Metode', 'Diskon dari', 'Member'],
        rows,
      };
    }
    case 'payments': {
      const rows: (string | number)[][] = [];
      for (const [id, list] of payments) {
        if (!counts(id)) continue;
        const o = info.get(id);
        for (const p of list) {
          if (!inRange(p)) continue;
          const s = localStamp(t(p), off);
          rows.push([s.date, s.time, id, METHOD[p.payload.method], p.payload.amount, p.payload.tid ?? '', p.payload.approvalCode ?? '', p.actorId ?? '', p.deviceId, o ? (TYPE[o.type as keyof typeof TYPE] ?? o.type) : '']);
        }
      }
      rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])) || String(a[2]).localeCompare(String(b[2])));
      return { slug: 'pembayaran', header: ['Tanggal', 'Jam', 'Order', 'Metode', 'Nominal', 'TID EDC', 'Kode approval', 'Kasir', 'Terminal', 'Jenis order'], rows };
    }
    case 'items': {
      const rows: (string | number)[][] = [];
      for (const { id, first } of counted) {
        const lines = bill.get(id)?.payload.items;
        if (!lines) continue;
        const s = localStamp(t(first), off);
        for (const l of lines) {
          rows.push([s.date, s.time, id, l.itemId, l.name, (l.options ?? []).map((x) => x.name).join(' · '), l.note ?? '', l.qty, l.unitPrice, l.qty * l.unitPrice]);
        }
      }
      return { slug: 'item', header: ['Tanggal', 'Jam', 'Order', 'ID menu', 'Menu', 'Pilihan', 'Catatan', 'Jumlah', 'Harga satuan', 'Nilai'], rows };
    }
    case 'exceptions': {
      const rows: (string | number)[][] = [];
      const push = (e: PosEvent, jenis: string, orderId: string, amount: number, detail: string, approver: string) => {
        const s = localStamp(t(e), off);
        rows.push([s.date, s.time, jenis, orderId, e.actorId ?? '', approver, amount, detail, e.deviceId]);
      };
      for (const e of sorted) {
        if (!inRange(e)) continue;
        if (e.type === 'void.approved' && voided.get(e.payload.orderId) === e && info.get(e.payload.orderId)?.type !== 'EMPLOYEE') {
          push(e, (payments.get(e.payload.orderId)?.length ?? 0) > 0 ? 'Void setelah dibayar' : 'Void', e.payload.orderId, e.payload.amount, e.payload.reasonCode, e.payload.approverIds.join(' + '));
        } else if (e.type === 'refund.created' && counts(e.payload.originalOrderId)) {
          push(e, 'Refund', e.payload.originalOrderId, e.payload.amount, METHOD[e.payload.method], e.payload.approverId);
        } else if (e.type === 'discount.applied' && counts(e.payload.orderId)) {
          const p = e.payload;
          push(e, 'Diskon', p.orderId, p.amount, `${p.kind}${p.promoId ? ` ${p.promoId}` : ''}${p.points ? ` ${p.points} poin` : ''} · ${p.percent}%${p.verified ? '' : ' · tanpa verifikasi'}`, p.approverId ?? '');
        }
      }
      return { slug: 'pengecualian', header: ['Tanggal', 'Jam', 'Jenis', 'Order', 'Kasir', 'Disetujui oleh', 'Nominal', 'Keterangan', 'Terminal'], rows };
    }
    case 'daily': {
      const days = new Map<string, { orders: number; gross: number; refunds: number; discount: number; voids: number }>();
      for (let d = input.from; d <= input.to; d = addDays(d, 1)) days.set(d, { orders: 0, gross: 0, refunds: 0, discount: 0, voids: 0 });
      const bucket = (e: PosEvent) => days.get(localDate(t(e), off));
      for (const { first } of counted) {
        const b = bucket(first);
        if (b) b.orders += 1;
      }
      for (const [id, list] of payments) {
        if (!counts(id)) continue;
        for (const p of list) if (inRange(p)) { const b = bucket(p); if (b) b.gross += p.payload.amount; }
      }
      for (const e of sorted) {
        if (!inRange(e)) continue;
        const b = bucket(e);
        if (!b) continue;
        if (e.type === 'refund.created' && counts(e.payload.originalOrderId)) b.refunds += e.payload.amount;
        else if (e.type === 'discount.applied' && counts(e.payload.orderId)) b.discount += e.payload.amount;
      }
      const rows = [...days].map(([date, v]) => [date, v.orders, v.gross, v.refunds, v.gross - v.refunds, v.orders > 0 ? Math.round(v.gross / v.orders) : 0, v.discount]);
      return { slug: 'harian', header: ['Tanggal', 'Order', 'Penerimaan', 'Refund', 'Penjualan bersih', 'Rata-rata per order', 'Diskon'], rows };
    }
  }
}
