'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { IconAlert, IconCard, IconChart, IconSliders } from './Icons';

/** Menu utama. Bar bawah di ponsel, rel ikon di tablet portrait, sidebar penuh di layar lebar (diatur CSS). */
export function NavLinks({ role }: { role: string }) {
  const path = usePathname();
  const items = [
    { href: '/', label: 'Insiden', icon: <IconAlert />, on: path === '/' || path.startsWith('/incidents'), show: true },
    {
      href: '/reports', label: 'Laporan', icon: <IconChart />, on: path.startsWith('/reports'),
      show: role === 'OWNER' || role === 'OPS' || role === 'MANAGER',
    },
    {
      href: '/settlements', label: 'Settlement', icon: <IconCard />, on: path.startsWith('/settlements'),
      show: role === 'OWNER' || role === 'OPS' || role === 'MANAGER',
    },
    { href: '/settings', label: 'Pengaturan', icon: <IconSliders />, on: path.startsWith('/settings'), show: role === 'OWNER' || role === 'OPS' },
  ];
  return (
    <nav className="nav" aria-label="Utama">
      {items.filter((i) => i.show).map((i) => (
        <Link key={i.href} href={i.href} className="nav-item" aria-current={i.on ? 'page' : undefined}>
          {i.icon}
          <span>{i.label}</span>
        </Link>
      ))}
    </nav>
  );
}
