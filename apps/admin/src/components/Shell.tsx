import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AdminMe } from '@/lib/api';
import { LogoutButton } from './LogoutButton';

export function Shell({ me, children }: { me: AdminMe; children: ReactNode }) {
  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="brand"><img src="/logo.png" width={28} height={28} alt="" aria-hidden="true" style={{ marginRight: 8, verticalAlign: 'middle' }} />Anatta POS <span className="admin-tag">ADMIN</span></Link>
        <nav className="who" aria-label="Utama">
          <Link href="/">Tenant</Link>
          <Link href="/tenants/new">Tenant baru</Link>
        </nav>
        <div className="who">
          <span>{me.adminId}</span>
          <LogoutButton />
        </div>
      </header>
      {children}
    </div>
  );
}
