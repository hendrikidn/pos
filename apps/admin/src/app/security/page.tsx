import { Shell } from '@/components/Shell';
import { SecurityManager } from '@/components/SecurityManager';
import { api, authed, type AdminMe, type AdminSecurityStatus } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function SecurityPage() {
  const { me, st } = await authed(async () => ({ me: await api<AdminMe>('/v1/admin/me'), st: await api<AdminSecurityStatus>('/v1/admin/auth/status') }));
  return (
    <Shell me={me}>
      <h1>Keamanan akun admin</h1>
      <p className="sub">Verifikasi 2 langkah dan sesi yang sedang masuk.</p>
      <SecurityManager status={st} />
    </Shell>
  );
}
