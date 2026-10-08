/**
 * Promo yang ditetapkan owner di server dan dikirim ke terminal. Kasir hanya memilih dari daftar ini, tidak mengetik persen sendiri,
 * jadi besar diskon ditentukan aturan (dan bisa diaudit), bukan kebijaksanaan kasir.
 */
export interface Promo {
  id: string;
  name: string;
  kind: 'PERCENT' | 'AMOUNT';
  /** PERCENT: 1–100 (persen dari subtotal). AMOUNT: rupiah potongan tetap. */
  value: number;
  /** Subtotal minimum agar promo berlaku. */
  minSubtotal?: number;
  /** Batas atas potongan untuk promo PERCENT (rupiah). */
  maxDiscount?: number;
  /** Hari berlaku, 0 = Minggu … 6 = Sabtu (menurut zona waktu outlet). Kosong = setiap hari. */
  days?: number[];
  /** Tanggal lokal outlet (YYYY-MM-DD), inklusif. */
  startDate?: string;
  endDate?: string;
  /** Jam berlaku [startHour, endHour) menurut jam lokal outlet; keduanya harus ada atau keduanya tidak. */
  startHour?: number;
  endHour?: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Tanggal kalender yang sah (menolak 2026-02-30 dan 2026-13-01). */
const validDate = (d: string): boolean => {
  if (!DATE.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
};

/** Memeriksa bentuk promo; mengembalikan pesan kesalahan atau null. Dipakai server saat menyimpan. */
export function checkPromo(p: Partial<Promo>): string | null {
  if (typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(p.id)) return 'id promo: huruf kecil, angka, - atau _ (maks. 32)';
  if (typeof p.name !== 'string' || p.name.trim().length < 1 || p.name.length > 40) return 'nama promo wajib (maks. 40 karakter)';
  if (p.kind !== 'PERCENT' && p.kind !== 'AMOUNT') return 'jenis promo harus PERCENT atau AMOUNT';
  if (!Number.isInteger(p.value) || p.value! < 1) return 'nilai promo harus bilangan bulat ≥ 1';
  if (p.kind === 'PERCENT' && p.value! > 100) return 'promo persen maksimal 100';
  if (p.kind === 'AMOUNT' && p.value! > 10_000_000) return 'potongan tetap maksimal Rp 10.000.000';
  if (p.minSubtotal !== undefined && (!Number.isInteger(p.minSubtotal) || p.minSubtotal < 0 || p.minSubtotal > 100_000_000)) return 'subtotal minimum tidak valid';
  if (p.maxDiscount !== undefined) {
    if (p.kind !== 'PERCENT') return 'batas potongan hanya untuk promo persen';
    if (!Number.isInteger(p.maxDiscount) || p.maxDiscount < 1 || p.maxDiscount > 10_000_000) return 'batas potongan tidak valid';
  }
  if (p.days !== undefined && (!Array.isArray(p.days) || p.days.length > 7 || new Set(p.days).size !== p.days.length || p.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) return 'hari harus daftar 0–6 tanpa pengulangan';
  for (const d of [p.startDate, p.endDate]) {
    if (d !== undefined && !validDate(d)) return 'tanggal harus berformat YYYY-MM-DD yang sah';
  }
  if (p.startDate && p.endDate && p.startDate > p.endDate) return 'tanggal mulai tidak boleh setelah tanggal akhir';
  if ((p.startHour === undefined) !== (p.endHour === undefined)) return 'jam mulai dan jam akhir harus diisi bersamaan';
  if (p.startHour !== undefined) {
    if (!Number.isInteger(p.startHour) || !Number.isInteger(p.endHour) || p.startHour! < 0 || p.endHour! > 24 || p.startHour! >= p.endHour!) return 'jam berlaku: mulai < akhir, dalam 0–24';
  }
  return null;
}

/** Besar potongan untuk subtotal tertentu (0 bila tidak ada). PERCENT dibulatkan ke rupiah dan dibatasi `maxDiscount`; tidak pernah melebihi subtotal. */
export function promoDiscount(p: Promo, subtotal: number): number {
  if (subtotal <= 0) return 0;
  const raw = p.kind === 'PERCENT' ? Math.round((subtotal * p.value) / 100) : p.value;
  const capped = p.kind === 'PERCENT' && p.maxDiscount !== undefined ? Math.min(raw, p.maxDiscount) : raw;
  return Math.min(capped, subtotal);
}

export type PromoCheck = { ok: true } | { ok: false; code: 'PROMO_MIN' | 'PROMO_SCHEDULE'; message: string };

/** Apakah promo berlaku pada waktu ini dan untuk subtotal ini (jadwal menurut zona waktu outlet). */
export function promoApplicable(p: Promo, ctx: { nowMs: number; utcOffsetMinutes: number; subtotal: number }): PromoCheck {
  const local = new Date(ctx.nowMs + ctx.utcOffsetMinutes * 60_000);
  const date = local.toISOString().slice(0, 10);
  if (p.startDate && date < p.startDate) return { ok: false, code: 'PROMO_SCHEDULE', message: `Promo ${p.name} baru berlaku mulai ${p.startDate}.` };
  if (p.endDate && date > p.endDate) return { ok: false, code: 'PROMO_SCHEDULE', message: `Promo ${p.name} sudah berakhir (${p.endDate}).` };
  if (p.days && p.days.length > 0 && !p.days.includes(local.getUTCDay())) return { ok: false, code: 'PROMO_SCHEDULE', message: `Promo ${p.name} tidak berlaku hari ini.` };
  if (p.startHour !== undefined && p.endHour !== undefined) {
    const h = local.getUTCHours();
    if (h < p.startHour || h >= p.endHour) return { ok: false, code: 'PROMO_SCHEDULE', message: `Promo ${p.name} hanya berlaku pukul ${String(p.startHour).padStart(2, '0')}.00–${String(p.endHour).padStart(2, '0')}.00.` };
  }
  if (p.minSubtotal !== undefined && ctx.subtotal < p.minSubtotal) {
    return { ok: false, code: 'PROMO_MIN', message: `Promo ${p.name} berlaku untuk belanja minimal Rp ${p.minSubtotal.toLocaleString('id-ID')}.` };
  }
  return { ok: true };
}
