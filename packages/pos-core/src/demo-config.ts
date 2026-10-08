import { derivePin } from './kdf';
import type { MenuItem, PosConfig } from './types';

export type DemoPins = Record<'budi' | 'sari' | 'hendra' | 'rina' | 'owner', string>;

const DEMO_ITERATIONS = 1_000;

/**
 * Konfigurasi demo tanpa server: menu kopi, lima staf, satu EDC. Hanya untuk mencoba aplikasi;
 * di outlet nyata konfigurasi selalu berasal dari server. PIN demo sengaja ditampilkan di layar masuk mode demo.
 */
/** Menu contoh (dipakai POS mode demo dan API demo). Dua menu memakai varian/tambahan. */
export const DEMO_MENU: MenuItem[] = [
      { id: 'kopi-susu', name: 'Kopi Susu', price: 22_000, category: 'Kopi' },
      { id: 'americano', name: 'Americano', price: 20_000, category: 'Kopi' },
      { id: 'latte', name: 'Latte', price: 26_000, category: 'Kopi' },
      {
        id: 'matcha', name: 'Matcha Latte', price: 28_000, category: 'Non-kopi',
        modifierGroups: [
          { id: 'ukuran', name: 'Ukuran', min: 1, max: 1, options: [{ id: 'regular', name: 'Regular', price: 0 }, { id: 'large', name: 'Large', price: 6_000 }] },
          { id: 'topping', name: 'Topping', min: 0, max: 2, options: [{ id: 'boba', name: 'Boba', price: 6_000 }, { id: 'oat', name: 'Oat Milk', price: 8_000 }] },
        ],
      },
      { id: 'teh', name: 'Teh Tarik', price: 18_000, category: 'Non-kopi' },
      { id: 'croissant', name: 'Croissant', price: 24_000, category: 'Makanan' },
      {
        id: 'nasi-goreng', name: 'Nasi Goreng', price: 38_000, category: 'Makanan',
        modifierGroups: [
          { id: 'pedas', name: 'Level pedas', min: 1, max: 1, options: [{ id: 'tidak', name: 'Tidak pedas', price: 0 }, { id: 'sedang', name: 'Sedang', price: 0 }, { id: 'pedas', name: 'Pedas', price: 0 }] },
          { id: 'tambahan', name: 'Tambahan', min: 0, max: 2, options: [{ id: 'telur', name: 'Telur', price: 5_000 }, { id: 'sate', name: 'Sate ayam', price: 12_000 }] },
        ],
      },
      { id: 'mie-goreng', name: 'Mie Goreng', price: 35_000, category: 'Makanan' },
      { id: 'wagyu-bowl', name: 'Wagyu Rice Bowl', price: 92_500, category: 'Makanan' },
];

export async function demoConfig(outletId = 'senopati', deviceId = 'pos-1'): Promise<PosConfig & { demoPins: DemoPins }> {
  const pins: DemoPins = { budi: '1111', sari: '2222', hendra: '3333', rina: '4444', owner: '9999' };
  const people = [
    { id: 'budi', name: 'Budi (Kasir)', role: 'CASHIER' as const },
    { id: 'sari', name: 'Sari (Kasir)', role: 'CASHIER' as const },
    { id: 'hendra', name: 'Hendra (Supervisor)', role: 'SUPERVISOR' as const },
    { id: 'rina', name: 'Rina (Manager)', role: 'MANAGER' as const },
    { id: 'owner', name: 'Owner', role: 'OWNER' as const },
  ];
  const staff = await Promise.all(
    people.map(async (p) => {
      const salt = `${p.id}-demo-salt`.padEnd(32, '0').split('').map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').slice(0, 32);
      return { ...p, salt, iterations: DEMO_ITERATIONS, hash: await derivePin(pins[p.id as keyof DemoPins], salt, DEMO_ITERATIONS) };
    }),
  );

  return {
    outletId, deviceId, merchantName: 'Kopi Senopati', taxPercent: 10, staff,
    edcs: [{ tid: '12345678', bank: 'Mandiri', label: 'EDC Mandiri' }],
    demoPins: pins,
    menu: DEMO_MENU,
  };
}
