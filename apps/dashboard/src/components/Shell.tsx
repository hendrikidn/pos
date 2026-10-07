import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Me } from '@/lib/api';
import { LogoutButton } from './LogoutButton';

export function Shell({ me, children }: { me: Me; children: ReactNode }) {
  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="brand">POS Guard</Link>
        <nav className="who" aria-label="Utama">
          <Link href="/">Insiden</Link>
          {(me.role === 'OWNER' || me.role === 'OPS' || me.role === 'MANAGER') && <Link href="/settlements">Settlement EDC</Link>}
          {(me.role === 'OWNER' || me.role === 'OPS') && <Link href="/settings">Pengaturan</Link>}
        </nav>
        <div className="who">
          <Link href="/account">{me.userId} · {me.role}</Link>
          <LogoutButton />
        </div>
      </header>
      {children}
    </div>
  );
}
