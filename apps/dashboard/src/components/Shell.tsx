import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Me } from '@/lib/api';
import { Logo } from './Icons';
import { LogoutButton } from './LogoutButton';
import { BillingBanner } from './BillingBanner';
import { NavLinks } from './NavLinks';

const ROLE_LABEL: Record<string, string> = { OWNER: 'Owner', OPS: 'Ops', MANAGER: 'Manager', SUPERVISOR: 'Supervisor' };

export function Shell({ me, children }: { me: Me; children: ReactNode }) {
  const initial = (me.userId.trim()[0] ?? '?').toUpperCase();
  const user = (
    <Link href="/account" className="usercard" aria-label={`Akun ${me.userId}`}>
      <span className="avatar" aria-hidden="true">{initial}</span>
      <span className="usertext">
        <b>{me.userId}</b>
        <small>{ROLE_LABEL[me.role] ?? me.role}</small>
      </span>
    </Link>
  );

  return (
    <div className="app">
      <header className="mobilebar">
        <Link href="/" className="brand"><Logo size={32} /><span>Anatta POS</span></Link>
        <div className="mobilebar-user">
          {user}
          <LogoutButton />
        </div>
      </header>

      <aside className="sidebar">
        <Link href="/" className="brand"><Logo /><span className="brand-text">Anatta POS</span></Link>
        <NavLinks role={me.role} />
        <div className="side-foot">
          {user}
          <LogoutButton />
        </div>
      </aside>

      <main className="main">
        <BillingBanner role={me.role} />
        {children}
      </main>
    </div>
  );
}
