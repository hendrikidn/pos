'use client';

import { useRouter } from 'next/navigation';
import { IconLogout } from './Icons';

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="logout"
      aria-label="Keluar"
      onClick={async () => {
        await fetch('/api/logout', { method: 'POST' });
        router.push('/login');
        router.refresh();
      }}
    >
      <IconLogout />
      <span>Keluar</span>
    </button>
  );
}
