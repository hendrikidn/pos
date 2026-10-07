import { dedupeBankTxns, type BankTxn, type ParseIssue } from '@pos/domain';

export interface ParseOptions {
  /** Offset zona waktu outlet dari UTC dalam menit. Default WIB (+420). */
  utcOffsetMinutes?: number;
}

export class ParseError extends Error {}

export function offsetOf(opts?: ParseOptions): number {
  return opts?.utcOffsetMinutes ?? 420;
}

/** Parser CSV minimal: kutip ganda, pemisah bebas, CRLF, BOM. Baris kosong dipertahankan sebagai [''] agar nomor baris tetap sesuai file. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export type AmountStyle = 'dot-decimal' | 'rp-id' | 'id-locale';

/** Mengubah teks nominal menjadi integer rupiah. Gagal jika bukan angka atau punya pecahan sen. */
export function parseAmount(raw: string, style: AmountStyle): number {
  const s = raw.trim();
  let normalized: string;
  switch (style) {
    case 'dot-decimal': // 45000.00
      normalized = s.replace(/[^0-9.-]/g, '');
      break;
    case 'rp-id': // Rp 32.000
      normalized = s.replace(/[^0-9-]/g, '');
      break;
    case 'id-locale': // 28.000,00
      normalized = s.replace(/[^0-9,-]/g, '').replace(',', '.');
      break;
  }
  const n = Number(normalized);
  if (normalized === '' || !Number.isFinite(n)) throw new Error(`nominal tidak valid: "${raw}"`);
  if (!Number.isInteger(n)) throw new Error(`nominal memiliki pecahan: "${raw}"`);
  return n;
}

/** Digit saja; nol di depan dipertahankan. */
export function digits(raw: string): string {
  return raw.replace(/\D/g, '');
}

export interface LocalDate {
  y: number;
  m: number;
  d: number;
}

export function parseDate(raw: string, sep: '/' | '-', order: 'dmy' | 'ymd' = 'dmy'): LocalDate {
  const parts = raw.trim().split(sep).map(Number);
  if (parts.length !== 3 || parts.some((p) => !Number.isInteger(p))) {
    throw new Error(`tanggal tidak valid: "${raw}"`);
  }
  const [a, b, c] = parts as [number, number, number];
  const date = order === 'dmy' ? { y: c, m: b, d: a } : { y: a, m: b, d: c };
  if (date.m < 1 || date.m > 12 || date.d < 1 || date.d > 31) {
    throw new Error(`tanggal tidak valid: "${raw}"`);
  }
  return date;
}

export function parseTime(raw: string): { h: number; mi: number; s: number } {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (!m) throw new Error(`jam tidak valid: "${raw}"`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3] ?? 0);
  if (h > 23 || mi > 59 || s > 59) throw new Error(`jam tidak valid: "${raw}"`);
  return { h, mi, s };
}

export function toEpochMs(d: LocalDate, t: { h: number; mi: number; s: number }, offsetMinutes: number): number {
  return Date.UTC(d.y, d.m - 1, d.d, t.h, t.mi, t.s) - offsetMinutes * 60_000;
}

export function endOfDayMs(d: LocalDate, offsetMinutes: number): number {
  return toEpochMs(d, { h: 23, mi: 59, s: 59 }, offsetMinutes) + 999;
}

export function isoDate(d: LocalDate): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.y}-${p(d.m)}-${p(d.d)}`;
}

/** Peta nama kolom → indeks. Gagal jika kolom wajib tidak ada, sehingga perubahan format bank tidak diam-diam menghasilkan data salah. */
export function headerIndex(header: string[], required: string[]): Map<string, number> {
  const map = new Map<string, number>();
  header.forEach((h, i) => map.set(h.trim(), i));
  const missing = required.filter((r) => !map.has(r));
  if (missing.length > 0) throw new ParseError(`kolom wajib tidak ditemukan: ${missing.join(', ')}`);
  return map;
}

/** Baris header = baris pertama yang memuat semua nama kolom penanda, di urutan mana pun. */
export function findHeaderRow(rows: string[][], markers: string[]): number {
  return rows.findIndex((r) => markers.every((m) => r.some((c) => c.trim() === m)));
}

/** Memproses baris data. Kegagalan satu baris dicatat dan tidak menghentikan baris lain. */
export function mapRows(
  rows: string[][],
  headerRow: number,
  cols: Map<string, number>,
  fn: (get: (name: string) => string, rowNo: number) => BankTxn,
): { txns: BankTxn[]; errors: ParseIssue[] } {
  const txns: BankTxn[] = [];
  const errors: ParseIssue[] = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.every((c) => c.trim() === '')) continue;
    const rowNo = i + 1;
    try {
      const get = (name: string) => (r[cols.get(name)!] ?? '').trim();
      txns.push(fn(get, rowNo));
    } catch (e) {
      errors.push({ row: rowNo, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { txns: dedupeBankTxns(txns), errors };
}
