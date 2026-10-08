import Link from 'next/link';

const ITEMS = [
  { href: '/settings/staff', label: 'Staf & PIN', key: 'staff' },
  { href: '/settings/menu', label: 'Menu', key: 'menu' },
  { href: '/settings/promos', label: 'Promo', key: 'promos' },
  { href: '/settings/members', label: 'Member', key: 'members' },
  { href: '/settings/ingredients', label: 'Bahan & resep', key: 'ingredients' },
  { href: '/settings/outlet', label: 'Outlet', key: 'outlet' },
  { href: '/settings/users', label: 'Pengguna', key: 'users' },
  { href: '/settings/billing', label: 'Langganan', key: 'billing' },
  { href: '/settings/devices', label: 'Perangkat', key: 'devices' },
] as const;

export function SettingsNav({ active, role }: { active: string; role: string }) {
  return (
    <nav className="tabs" aria-label="Pengaturan">
      {ITEMS.filter((i) => role === 'OWNER' || (role === 'OPS' && (i.key === 'menu' || i.key === 'promos' || i.key === 'members' || i.key === 'ingredients' || i.key === 'devices'))).map((i) => (
        <Link key={i.key} className="tab" href={i.href} aria-current={active === i.key ? 'page' : undefined}>{i.label}</Link>
      ))}
    </nav>
  );
}
