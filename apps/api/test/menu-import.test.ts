import { describe, expect, it } from 'vitest';
import { MENU_IMPORT_MAX_ROWS, parseMenuCsv, parsePrice, slugify, splitCsv } from '../src/menu-import';

describe('parsePrice', () => {
  it('berbagai penulisan rupiah; selain bilangan bulat ditolak', () => {
    for (const [v, n] of [['22000', 22000], ['22.000', 22000], ['Rp 22.000', 22000], ['Rp22.000', 22000], ['1.250.000', 1250000], ['22,000', 22000], ['0', 0], [' 15000 ', 15000]] as const) expect(parsePrice(v)).toBe(n);
    for (const v of ['', 'gratis', '22.5', '22.50', '-1000', '1.2.3', '22 000x', '1,5']) expect(parsePrice(v)).toBeNull();
  });
});

describe('splitCsv', () => {
  it('kutip ganda berisi pemisah, kutip, dan baris baru; CRLF dan LF', () => {
    expect(splitCsv('a,"b,c","d ""e""",f\r\n1,"x\ny",3,4\n', ',')).toEqual([['a', 'b,c', 'd "e"', 'f'], ['1', 'x\ny', '3', '4']]);
    expect(splitCsv('a;b\n1;2', ';')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('parseMenuCsv', () => {
  const ok = (csv: string) => { const p = parseMenuCsv(csv); expect(p.errors).toEqual([]); return p.rows; };

  it('templat dan alias kolom Indonesia/Inggris; id dibuat dari nama; harga berformat Indonesia', () => {
    const rows = ok('id,nama,kategori,harga,aktif\nkopi-susu,Kopi Susu,Kopi,22000,ya\n,Nasi Goreng Spesial,Makanan,"Rp 38.000",tidak\n');
    expect(rows).toEqual([
      { line: 2, id: 'kopi-susu', name: 'Kopi Susu', category: 'Kopi', price: 22000, active: true },
      { line: 3, id: 'nasi-goreng-spesial', name: 'Nasi Goreng Spesial', category: 'Makanan', price: 38000, active: false },
    ]);
    expect(ok('Name;Category;Price\nTeh;Minuman;15000\n')[0]).toMatchObject({ id: 'teh', price: 15000, active: true });
  });

  it('titik koma (Excel Indonesia) dan tab terdeteksi; BOM dibuang', () => {
    expect(parseMenuCsv('﻿nama;kategori;harga\nTeh;Minuman;15000').delimiter).toBe(';');
    expect(ok('﻿nama\tkategori\tharga\nTeh\tMinuman\t15000')[0]!.name).toBe('Teh');
  });

  it('id otomatis tidak bentrok di dalam berkas; aksen dan simbol dibersihkan; panjang dibatasi', () => {
    const rows = ok('nama,kategori,harga\nEs Teh,M,1000\nEs  Teh!,M,1000\nCrème Brûlée,D,2000\n' + `${'x'.repeat(50)},M,1\n`);
    expect(rows.map((r) => r.id)).toEqual(['es-teh', 'es-teh-2', 'creme-brulee', 'x'.repeat(32)]);
    expect(slugify('!!!')).toBe('');
    expect(ok('nama,kategori,harga\n!!!,M,1\n')[0]!.id).toBe('menu');
  });

  it('semua kesalahan dilaporkan dengan nomor baris; baris yang sah tetap terbaca', () => {
    const p = parseMenuCsv('id,nama,kategori,harga,aktif\nA B,Kopi,Kopi,1000,ya\nok,,Kopi,1000,ya\nok2,Teh,,1000,ya\nok3,Roti,Makanan,gratis,ya\nok4,Susu,Minuman,1000,mungkin\nok5,Jus,Minuman,1000,ya\n');
    expect(p.errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 6]);
    expect(p.errors[0]!.message).toContain('id "a b" tidak valid');
    expect(p.errors[3]!.message).toContain('harga "gratis"');
    expect(p.errors[4]!.message).toContain('status "mungkin"');
    expect(p.rows.map((r) => r.id)).toEqual(['ok5']);
  });

  it('id kembar di berkas ditolak; baris kosong diabaikan', () => {
    const p = parseMenuCsv('id,nama,kategori,harga\na,Kopi,K,1000\n\n,,,\na,Teh,K,2000\n');
    expect(p.errors).toEqual([{ line: 5, message: 'id "a" kembar dengan baris 2' }]);
    expect(p.rows).toHaveLength(1);
  });

  it('berkas tanpa kolom wajib, kosong, tanpa baris, atau terlalu besar ditolak seluruhnya', () => {
    expect(parseMenuCsv('nama,kategori\nTeh,M').errors[0]!.message).toContain('harga');
    expect(parseMenuCsv('foo,bar\n1,2').errors).toHaveLength(3);
    expect(parseMenuCsv('   \n').errors[0]!.message).toBe('berkas kosong');
    expect(parseMenuCsv('nama,kategori,harga\n').errors[0]!.message).toBe('tidak ada baris menu');
    const many = 'nama,kategori,harga\n' + Array.from({ length: MENU_IMPORT_MAX_ROWS + 1 }, (_, i) => `M${i},K,1000`).join('\n');
    expect(parseMenuCsv(many).errors[0]!.message).toContain('maksimal 500');
    expect(parseMenuCsv('nama,kategori,harga\n' + 'x'.repeat(210_000)).errors[0]!.message).toContain('200 KB');
  });
});
