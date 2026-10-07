'use client';

import { useRouter } from 'next/navigation';

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="secondary"
      onClick={async () => {
        await fetch('/api/logout', { method: 'POST' });
        router.push('/login');
        router.refresh();
      }}
    >
      Keluar
    </button>
  );
}
