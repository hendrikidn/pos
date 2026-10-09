/**
 * Daftar alamat yang diizinkan (`ADMIN_ALLOWED_IPS`, pisahkan koma): alamat IPv4/IPv6 tunggal atau CIDR IPv4 (mis. 203.0.113.0/24). Alamat IPv4 yang
 * dibungkus IPv6 (`::ffff:1.2.3.4`) dinormalkan. Daftar kosong = tidak membatasi. Entri yang tidak dikenal membuat daftar menolak semua
 * (lebih aman gagal tertutup daripada diam-diam terbuka karena salah ketik).
 */
const v4 = (s: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.some((n) => n > 255) ? null : ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
};

export const normalizeIp = (ip: string): string => ip.trim().toLowerCase().replace(/^::ffff:/, '');

export function parseAllowList(raw: string | undefined): { open: boolean; test: (ip: string | undefined) => boolean } {
  const items = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) return { open: true, test: () => true };
  const nets: { base: number; mask: number }[] = [];
  const exact = new Set<string>();
  let broken = false;
  for (const it of items) {
    const [addr, bits] = it.split('/');
    const n = v4(normalizeIp(addr!));
    if (n !== null && bits !== undefined) {
      const b = Number(bits);
      if (!Number.isInteger(b) || b < 0 || b > 32) { broken = true; continue; }
      const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
      nets.push({ base: (n & mask) >>> 0, mask });
    } else if (bits === undefined && (n !== null || /^[0-9a-f:]+$/.test(normalizeIp(addr!)))) {
      exact.add(normalizeIp(addr!));
    } else broken = true;
  }
  return {
    open: false,
    test: (ip) => {
      if (broken || !ip) return false;
      const x = normalizeIp(ip);
      if (exact.has(x)) return true;
      const n = v4(x);
      return n !== null && nets.some((net) => ((n & net.mask) >>> 0) === net.base);
    },
  };
}
