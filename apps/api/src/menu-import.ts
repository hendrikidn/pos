/** Impor menu massal dari CSV (Excel/Sheets). Murni: tidak menyentuh database; `ConfigService.importMenu` yang menerapkannya. */

export const MENU_IMPORT_MAX_ROWS = 500;
export const MENU_IMPORT_MAX_BYTES = 200 * 1024;

export interface ImportRow {
  /** Nomor baris di berkas (1 = judul), untuk pesan kesalahan. */
  line: number;
  id: string;
  name: string;
  category: string;
  price: number;
  active: boolean;
}

export interface ImportError {
  line: number;
  message: string;
}

export interface ParsedMenu {
  rows: ImportRow[];
  errors: ImportError[];
  /** Pemisah kolom yang terdeteksi. */
  delimiter: ',' | ';' | '\t';
}

const ALIASES: Record<string, 'id' | 'name' | 'category' | 'price' | 'active'> = {
  id: 'id', kode: 'id', sku: 'id',
  nama: 'name', name: 'name', menu: 'name', produk: 'name', 'nama menu': 'name', 'nama produk': 'name',
  kategori: 'category', category: 'category', grup: 'category',
  harga: 'price', price: 'price', 'harga jual': 'price',
  aktif: 'active', active: 'active', status: 'active',
};

/** Memecah teks CSV menjadi sel dengan aturan kutip RFC 4180 (kutip ganda, koma/baris baru di dalam kutip). */
export function splitCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/** Pemisah dipilih dari baris judul: yang paling banyak muncul di luar kutip (Excel berbahasa Indonesia memakai titik koma). */
function detectDelimiter(head: string): ',' | ';' | '\t' {
  const count = (d: string) => (head.replace(/"[^"]*"/g, '').split(d).length - 1);
  const best = ([',', ';', '\t'] as const).map((d) => [d, count(d)] as const).sort((a, b) => b[1] - a[1])[0]!;
  return best[1] > 0 ? best[0] : ',';
}

/** "22000", "22.000", "Rp 22.000", "22,000" → 22000; selain bilangan bulat rupiah → null. */
export function parsePrice(raw: string): number | null {
  const s = raw.trim().replace(/^rp\.?\s*/i, '').replace(/\s/g, '');
  if (s === '') return null;
  // Titik atau koma sebagai pemisah ribuan (tepat tiga digit di belakangnya); desimal dengan sen tidak didukung.
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ''));
  if (/^\d+$/.test(s)) return Number(s);
  return null;
}

const TRUE = new Set(['ya', 'y', 'aktif', 'true', '1', 'yes']);
const FALSE = new Set(['tidak', 'n', 't', 'nonaktif', 'false', '0', 'no']);

export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
}

export function parseMenuCsv(textRaw: string): ParsedMenu {
  const text = textRaw.replace(/^﻿/, '');
  const errors: ImportError[] = [];
  if (text.trim() === '') return { rows: [], errors: [{ line: 1, message: 'berkas kosong' }], delimiter: ',' };
  if (Buffer.byteLength(text) > MENU_IMPORT_MAX_BYTES) return { rows: [], errors: [{ line: 1, message: `berkas lebih dari ${MENU_IMPORT_MAX_BYTES / 1024} KB` }], delimiter: ',' };
  const delimiter = detectDelimiter(text.split(/\r?\n/, 1)[0]!);
  // Nomor baris mengikuti urutan catatan di berkas (baris kosong tetap dihitung), supaya pesan kesalahan menunjuk baris yang benar di Excel.
  const records = splitCsv(text, delimiter).map((r, i) => ({ r, line: i + 1 })).filter((x) => x.r.some((c) => c.trim() !== ''));
  const table = records.map((x) => x.r);
  const header = table[0]!.map((h) => ALIASES[h.trim().toLowerCase()]);
  const col = (k: 'id' | 'name' | 'category' | 'price' | 'active') => header.indexOf(k);
  for (const k of ['name', 'category', 'price'] as const) {
    if (col(k) < 0) errors.push({ line: 1, message: `kolom ${k === 'name' ? 'nama' : k === 'category' ? 'kategori' : 'harga'} tidak ditemukan di baris judul` });
  }
  if (errors.length > 0) return { rows: [], errors, delimiter };
  const body = records.slice(1);
  if (body.length === 0) return { rows: [], errors: [{ line: 2, message: 'tidak ada baris menu' }], delimiter };
  if (body.length > MENU_IMPORT_MAX_ROWS) return { rows: [], errors: [{ line: 1, message: `maksimal ${MENU_IMPORT_MAX_ROWS} menu per impor (berkas memuat ${body.length})` }], delimiter };

  const rows: ImportRow[] = [];
  const seen = new Map<string, number>();
  const cell = (r: string[], k: 'id' | 'name' | 'category' | 'price' | 'active') => (col(k) >= 0 ? (r[col(k)] ?? '').trim() : '');
  body.forEach(({ r, line }) => {
    const bad = (message: string) => errors.push({ line, message });
    const name = cell(r, 'name');
    const category = cell(r, 'category');
    const price = parsePrice(cell(r, 'price'));
    let id = cell(r, 'id').toLowerCase();
    let ok = true;
    if (name === '' || name.length > 60) { bad('nama wajib (maks. 60 karakter)'); ok = false; }
    if (category === '' || category.length > 30) { bad('kategori wajib (maks. 30 karakter)'); ok = false; }
    if (price === null || price > 100_000_000) { bad(`harga "${cell(r, 'price')}" tidak valid (bilangan bulat rupiah, 0–100.000.000)`); ok = false; }
    if (id !== '' && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) { bad(`id "${id}" tidak valid: huruf kecil, angka, - atau _ (maks. 32)`); ok = false; }
    let active = true;
    const a = cell(r, 'active').toLowerCase();
    if (a !== '') {
      if (TRUE.has(a)) active = true;
      else if (FALSE.has(a)) active = false;
      else { bad(`status "${a}" tidak dikenal (isi ya atau tidak)`); ok = false; }
    }
    if (!ok) return;
    if (id === '') {
      // id dibuat dari nama; bila kembar di berkas diberi nomor
      const base = slugify(name) || 'menu';
      id = base;
      for (let n = 2; seen.has(id); n++) id = `${base.slice(0, 29)}-${n}`;
    } else if (seen.has(id)) { bad(`id "${id}" kembar dengan baris ${seen.get(id)}`); return; }
    seen.set(id, line);
    rows.push({ line, id, name, category, price: price!, active });
  });
  return { rows, errors, delimiter };
}

export const MENU_IMPORT_TEMPLATE = 'id,nama,kategori,harga,aktif\r\nkopi-susu,Kopi Susu,Kopi,22000,ya\r\n,Nasi Goreng,Makanan,"38.000",ya\r\n';
