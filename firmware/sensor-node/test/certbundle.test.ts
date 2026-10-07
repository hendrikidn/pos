import { readFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';

/**
 * Bundel root CA yang dibenamkan di firmware (certs/x509_crt_bundle.bin) dibaca di perangkat oleh esp_crt_bundle.c:
 * 2 byte jumlah, lalu per sertifikat {2 byte panjang nama, 2 byte panjang kunci, nama subjek DER, kunci SPKI DER},
 * terurut menurut nama (pencarian biner). Tes ini memastikan berkas yang dibuat tools/gen_cert_bundle.py sesuai format itu.
 */
const bundle = readFileSync(new URL('../certs/x509_crt_bundle.bin', import.meta.url));

function parse() {
  const count = bundle.readUInt16BE(0);
  const entries: { name: Buffer; key: Buffer }[] = [];
  let off = 2;
  for (let i = 0; i < count; i++) {
    const nameLen = bundle.readUInt16BE(off);
    const keyLen = bundle.readUInt16BE(off + 2);
    entries.push({ name: bundle.subarray(off + 4, off + 4 + nameLen), key: bundle.subarray(off + 4 + nameLen, off + 4 + nameLen + keyLen) });
    off += 4 + nameLen + keyLen;
  }
  return { count, entries, end: off };
}

describe('bundel root CA firmware', () => {
  it('panjang berkas persis sama dengan jumlah entri yang dinyatakan', () => {
    const { count, entries, end } = parse();
    expect(count).toBeGreaterThan(50);
    expect(entries).toHaveLength(count);
    expect(end).toBe(bundle.length);
  });

  it('terurut menurut nama subjek (syarat pencarian biner di perangkat) dan tanpa nama ganda', () => {
    const names = parse().entries.map((e) => e.name);
    for (let i = 1; i < names.length; i++) expect(Buffer.compare(names[i - 1]!, names[i]!)).toBeLessThan(0);
  });

  it('setiap kunci adalah SPKI yang sah', () => {
    for (const e of parse().entries) expect(() => createPublicKey({ key: e.key, format: 'der', type: 'spki' })).not.toThrow();
  });

  it('memuat root yang dipakai Let\'s Encrypt (penerbit Caddy)', () => {
    const subjects = parse().entries.map((e) => e.name.toString('latin1'));
    expect(subjects.some((s) => s.includes('ISRG Root X1'))).toBe(true);
    expect(subjects.some((s) => s.includes('ISRG Root X2'))).toBe(true);
  });

  it('ukurannya wajar untuk flash (kurang dari 100 KB)', () => {
    expect(bundle.length).toBeLessThan(100 * 1024);
  });
});
