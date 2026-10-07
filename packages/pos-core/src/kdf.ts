import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Turunan PIN: PBKDF2-HMAC-SHA256, 32 byte. Harus identik dengan yang dihitung server saat PIN dibuat.
 * Memakai WebCrypto bila ada (cepat, native). Halaman HTTP non-localhost tidak punya `crypto.subtle`,
 * sehingga dipakai implementasi JS yang jauh lebih lambat; di produksi sajikan lewat HTTPS atau aplikasi terbungkus.
 */
export async function derivePin(pin: string, saltHex: string, iterations: number): Promise<string> {
  const salt = hexToBytes(saltHex);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const key = await subtle.importKey('raw', utf8ToBytes(pin) as BufferSource, 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
    return bytesToHex(new Uint8Array(bits));
  }
  return bytesToHex(pbkdf2(sha256, utf8ToBytes(pin), salt, { c: iterations, dkLen: 32 }));
}

/** Perbandingan string berwaktu tetap, agar waktu respons tidak membocorkan seberapa jauh tebakan cocok. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
