import { ChangePasswordForm } from '@/components/ChangePasswordForm';
import { Shell } from '@/components/Shell';
import { SessionsPanel } from '@/components/SessionsPanel';
import { api, authed, type Me, type SessionRow } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const { me, sessions } = await authed(async () => ({ me: await api<Me>('/v1/me'), sessions: (await api<{ sessions: SessionRow[] }>('/v1/auth/sessions')).sessions }));
  return (
    <Shell me={me}>
      <h1>Akun</h1>
      <p className="sub">{me.userId} · {me.role}</p>
      <ChangePasswordForm />
      <SessionsPanel sessions={sessions} />
      <p className="muted small">Lupa password saat ini? Keluar, lalu di halaman masuk pilih &quot;Lupa password / atur password&quot;.</p>
    </Shell>
  );
}
