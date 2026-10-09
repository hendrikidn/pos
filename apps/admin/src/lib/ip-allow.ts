/** Daftar alamat yang diizinkan (`ADMIN_ALLOWED_IPS`); salinan ringan dari apps/api/src/ip-allow.ts (middleware berjalan di edge, tanpa modul Node). Entri rusak = tolak semua. */
const v4 = (s: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.some((n) => n > 255) ? null : ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
};
const norm = (ip: string) => ip.trim().toLowerCase().replace(/^::ffff:/, '');

export function allowedByList(raw: string | undefined, ip: string | null): boolean {
  const items = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) return true;
  if (!ip) return false;
  const x = norm(ip);
  const n = v4(x);
  for (const it of items) {
    const [addr, bits] = it.split('/');
    const base = v4(norm(addr!));
    if (bits !== undefined) {
      const b = Number(bits);
      if (base === null || !Number.isInteger(b) || b < 0 || b > 32) return false;
      const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
      if (n !== null && ((n & mask) >>> 0) === ((base & mask) >>> 0)) return true;
    } else if (norm(addr!) === x) return true;
    else if (base === null && !/^[0-9a-f:]+$/.test(norm(addr!))) return false;
  }
  return false;
}

/** Alamat klien dari web server di depan (nginx menaruhnya di X-Real-IP dan sebagai entri terakhir X-Forwarded-For). */
export function clientIp(h: Headers): string | null {
  const real = h.get('x-real-ip');
  if (real) return real.trim();
  const xff = h.get('x-forwarded-for');
  return xff ? xff.split(',').pop()!.trim() : null;
}
