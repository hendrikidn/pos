import { describe, expect, it } from 'vitest';
import { checkModifierGroups, resolveSelection, type ModifierGroup } from '../src';

const size: ModifierGroup = { id: 'ukuran', name: 'Ukuran', min: 1, max: 1, options: [{ id: 'kecil', name: 'Kecil', price: 0 }, { id: 'sedang', name: 'Sedang', price: 3_000 }, { id: 'besar', name: 'Besar', price: 6_000 }] };
const spice: ModifierGroup = { id: 'pedas', name: 'Level pedas', min: 1, max: 1, options: [{ id: 'tidak', name: 'Tidak pedas', price: 0 }, { id: 'sedang', name: 'Sedang', price: 0 }, { id: 'pedas', name: 'Pedas', price: 0 }] };

describe('id opsi unik di seluruh menu', () => {
  it('"Sedang" di dua grup berbeda (id sama) ditolak saat menyimpan, dengan pesan yang menjelaskan', () => {
    expect(checkModifierGroups([size, spice])).toMatch(/id opsi ganda pada menu ini/);
  });

  it('id berbeda di grup berbeda diterima, dan kedua grup bisa dipilih bersamaan', () => {
    const ok: ModifierGroup[] = [size, { ...spice, options: spice.options.map((o) => (o.id === 'sedang' ? { ...o, id: 'pedas-sedang' } : o)) }];
    expect(checkModifierGroups(ok)).toBeNull();
    const sel = resolveSelection(ok, ['sedang', 'pedas-sedang']);
    expect(sel).toMatchObject({ ok: true, extra: 3_000 });
    expect(sel.ok && sel.options.map((o) => `${o.groupId}:${o.optionId}`)).toEqual(['ukuran:sedang', 'pedas:pedas-sedang']);
  });
});
