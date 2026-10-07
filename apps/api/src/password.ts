import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { BadRequestException } from '@nestjs/common';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

/** scrypt N=2^16, r=8, p=1: 64 MiB dan sekitar 120 ms per hash. Parameter ikut tersimpan di hash sehingga bisa dinaikkan kelak. */
const PARAMS = { N: 65_536, r: 8, p: 1 };
const KEYLEN = 32;
const MAXMEM = 256 * 1024 * 1024;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, KEYLEN, { ...PARAMS, maxmem: MAXMEM });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | undefined;
/**
 * Verifikasi tiruan untuk email yang tidak ada, nonaktif, atau belum punya password. Memakan waktu yang sama dengan verifikasi
 * sungguhan, sehingga lamanya respons tidak membedakan email terdaftar dari yang tidak.
 */
export async function burnVerify(password: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(12).toString('hex'));
  await verifyPassword(password, await dummy);
}

/** Sebagian kecil kata sandi paling umum. Bukan daftar lengkap; hanya menolak pilihan yang paling malas. */
const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd123', 'qwertyuiop', 'qwerty12345', 'qwerty123456', 'abcdefghij',
  '1234567890', '12345678910', '0123456789', '1q2w3e4r5t', 'iloveyou12', 'welcome123', 'admin12345', 'administrator', 'letmein1234',
  'kasir12345', 'posguard123', 'indonesia123', 'bismillah123', 'sayangku123', 'rahasia123', 'rahasia1234', 'katasandi123',
]);

/** Aturan mengikuti pedoman NIST: panjang, bukan komposisi karakter. Menolak yang mudah ditebak. */
export function checkPassword(password: unknown, email: string): string {
  if (typeof password !== 'string') throw new BadRequestException('password wajib diisi');
  if (password.length < PASSWORD_MIN) throw new BadRequestException(`password minimal ${PASSWORD_MIN} karakter`);
  if (password.length > PASSWORD_MAX) throw new BadRequestException(`password maksimal ${PASSWORD_MAX} karakter`);
  const lower = password.toLowerCase();
  if (/^(.)\1+$/.test(password)) throw new BadRequestException('password terlalu mudah ditebak (karakter berulang)');
  if (COMMON.has(lower.replace(/\s/g, ''))) throw new BadRequestException('password terlalu umum; pilih yang lain');
  const local = email.split('@')[0]!.toLowerCase();
  if (local.length >= 4 && lower.includes(local)) throw new BadRequestException('password tidak boleh memuat nama email Anda');
  return password;
}
