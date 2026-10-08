/**
 * Varian dan tambahan menu. Satu konsep: grup opsi dengan batas jumlah pilihan.
 *  - Varian (ukuran, level pedas): `min: 1, max: 1`, kasir wajib memilih satu.
 *  - Tambahan (shot, topping): `min: 0, max: n`, boleh kosong atau beberapa.
 * Harga opsi ditambahkan ke harga dasar menu.
 */
export interface ModifierOption {
  id: string;
  name: string;
  /** Tambahan harga (rupiah, ≥ 0). */
  price: number;
}

export interface ModifierGroup {
  id: string;
  name: string;
  min: number;
  max: number;
  options: ModifierOption[];
}

/** Opsi yang dipilih pada satu baris pesanan, disalin lengkap dengan nama dan harga saat kejadian. */
export interface ChosenOption {
  groupId: string;
  group: string;
  optionId: string;
  name: string;
  price: number;
}

export const MAX_GROUPS = 8;
export const MAX_OPTIONS_PER_GROUP = 20;
export const MAX_NOTE_LENGTH = 140;
export const MAX_OPTION_PRICE = 1_000_000;
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Memeriksa definisi grup dari owner. Mengembalikan pesan kesalahan, atau null bila valid. */
export function checkModifierGroups(groups: unknown): string | null {
  if (!Array.isArray(groups)) return 'modifierGroups harus berupa daftar';
  if (groups.length > MAX_GROUPS) return `maksimal ${MAX_GROUPS} grup opsi per menu`;
  const groupIds = new Set<string>();
  // Id opsi harus unik di SELURUH menu (bukan hanya per grup): pilihan kasir, kunci resep `menu|opsi`, dan KDS memperlakukannya demikian.
  const optionIds = new Set<string>();
  for (const g of groups as Record<string, unknown>[]) {
    if (typeof g !== 'object' || g === null) return 'grup opsi tidak valid';
    if (typeof g['id'] !== 'string' || !ID.test(g['id'])) return 'id grup: huruf kecil, angka, - atau _ (maks. 32)';
    if (groupIds.has(g['id'])) return `id grup ganda: ${g['id']}`;
    groupIds.add(g['id']);
    if (typeof g['name'] !== 'string' || g['name'].trim() === '' || g['name'].length > 40) return 'nama grup wajib (maks. 40)';
    const opts = g['options'];
    if (!Array.isArray(opts) || opts.length < 1 || opts.length > MAX_OPTIONS_PER_GROUP) return `grup "${g['name']}" harus punya 1–${MAX_OPTIONS_PER_GROUP} opsi`;
    const { min, max } = g as { min: unknown; max: unknown };
    if (!Number.isInteger(min) || !Number.isInteger(max) || (min as number) < 0 || (max as number) < 1 || (min as number) > (max as number) || (max as number) > opts.length) {
      return `grup "${g['name']}": batas pilihan tidak valid (0 ≤ min ≤ max ≤ jumlah opsi, max ≥ 1)`;
    }
    for (const o of opts as Record<string, unknown>[]) {
      if (typeof o !== 'object' || o === null) return 'opsi tidak valid';
      if (typeof o['id'] !== 'string' || !ID.test(o['id'])) return 'id opsi: huruf kecil, angka, - atau _ (maks. 32)';
      if (optionIds.has(o['id'])) return `id opsi ganda pada menu ini (harus unik di semua grup): ${o['id']}`;
      optionIds.add(o['id']);
      if (typeof o['name'] !== 'string' || o['name'].trim() === '' || o['name'].length > 40) return 'nama opsi wajib (maks. 40)';
      if (!Number.isInteger(o['price']) || (o['price'] as number) < 0 || (o['price'] as number) > MAX_OPTION_PRICE) return `harga opsi "${o['name']}" harus bilangan bulat rupiah 0–${MAX_OPTION_PRICE}`;
    }
  }
  return null;
}

export type Selection =
  | { ok: true; options: ChosenOption[]; extra: number }
  | { ok: false; code: 'OPTION_UNKNOWN' | 'OPTION_REQUIRED' | 'OPTION_TOO_MANY'; message: string };

/**
 * Mencocokkan pilihan (daftar id opsi) dengan grup menu. Pilihan yang tidak dikenal, kurang dari batas minimum, atau
 * melebihi batas maksimum ditolak. Hasilnya berurutan menurut grup lalu opsi, sehingga pilihan yang sama selalu menghasilkan
 * baris yang sama.
 */
export function resolveSelection(groups: ModifierGroup[] | undefined, optionIds: string[]): Selection {
  const wanted = new Set(optionIds);
  if (wanted.size !== optionIds.length) return { ok: false, code: 'OPTION_UNKNOWN', message: 'Opsi dipilih lebih dari sekali.' };
  const options: ChosenOption[] = [];
  for (const g of groups ?? []) {
    const picked = g.options.filter((o) => wanted.has(o.id));
    for (const o of picked) wanted.delete(o.id);
    if (picked.length < g.min) {
      return { ok: false, code: 'OPTION_REQUIRED', message: g.min === 1 ? `Pilih ${g.name}.` : `Pilih minimal ${g.min} untuk ${g.name}.` };
    }
    if (picked.length > g.max) {
      return { ok: false, code: 'OPTION_TOO_MANY', message: g.max === 1 ? `${g.name}: pilih satu saja.` : `${g.name}: maksimal ${g.max} pilihan.` };
    }
    for (const o of picked) options.push({ groupId: g.id, group: g.name, optionId: o.id, name: o.name, price: o.price });
  }
  if (wanted.size > 0) return { ok: false, code: 'OPTION_UNKNOWN', message: 'Opsi tidak dikenal untuk menu ini.' };
  return { ok: true, options, extra: options.reduce((s, o) => s + o.price, 0) };
}
