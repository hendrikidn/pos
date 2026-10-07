import { ChangePasswordForm } from '@/components/ChangePasswordForm';
import { Shell } from '@/components/Shell';
import { api, authed, type Me } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const me = await authed(() => api<Me>('/v1/me'));
  return (
    <Shell me={me}>
      <h1>Akun</h1>
      <p className="sub">{me.userId} · {me.role}</p>
      <ChangePasswordForm />
      <p className="muted small">Lupa password saat ini? Keluar, lalu di halaman masuk pilih &quot;Lupa password / atur password&quot;.</p>
    </Shell>
  );
}
