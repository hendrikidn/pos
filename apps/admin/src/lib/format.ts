/** Fungsi tampilan murni, aman dipakai di komponen klien (tidak menyentuh next/headers). */
const DAY_MS = 86_400_000;
export function ago(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return 'baru saja';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} mnt lalu`;
  if (diff < DAY_MS) return `${Math.floor(diff / 3_600_000)} jam lalu`;
  return `${Math.floor(diff / DAY_MS)} hari lalu`;
}

export const dateWib = (iso: string) =>
  new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
