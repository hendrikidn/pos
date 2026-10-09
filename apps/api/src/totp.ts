import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** TOTP (RFC 6238, HMAC-SHA1, 6 angka, langkah 30 dtk) tanpa pustaka tambahan, kompatibel dengan Google Authenticator, Authy, 1Password, dll. */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/[\s=-]/g, '').toUpperCase()) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('base32 tidak valid');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

/** Kode untuk satu langkah waktu. */
export function totpAt(secret: string, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1]! & 15;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepOf = (nowMs: number): number => Math.floor(nowMs / STEP_MS);

/**
 * Memeriksa kode terhadap langkah sekarang dan satu langkah sebelum/sesudahnya (toleransi jam 30 dtk). Mengembalikan langkah yang cocok
 * (untuk dicatat sebagai `totp_last_step`), atau null. Langkah yang sudah pernah dipakai (`lastStep`) ditolak: tidak bisa diputar ulang.
 */
export function verifyTotp(secret: string, codeRaw: unknown, nowMs: number, lastStep = 0): number | null {
  const code = typeof codeRaw === 'string' ? codeRaw.replace(/\s/g, '') : '';
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepOf(nowMs);
  for (const step of [now, now - 1, now + 1]) {
    if (step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

export const otpauthUrl = (account: string, secret: string, issuer = 'Anatta POS'): string =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/**
 * Rahasia TOTP disimpan terenkripsi (AES-256-GCM) bila `SECRETS_KEY` diisi, supaya bocornya basis data saja tidak membocorkan faktor kedua.
 * Tanpa kunci, tersimpan apa adanya (awalan `plain:`); `open` membaca keduanya, jadi kunci bisa dipasang belakangan.
 */
export function seal(plain: string, key = process.env['SECRETS_KEY']): string {
  if (!key) return `plain:${plain}`;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function open(sealed: string, key = process.env['SECRETS_KEY']): string {
  if (sealed.startsWith('plain:')) return sealed.slice(6);
  const [v, iv, tag, ct] = sealed.split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('format rahasia tidak dikenal');
  if (!key) throw new Error('SECRETS_KEY diperlukan untuk membuka rahasia ini');
  const d = createDecipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
