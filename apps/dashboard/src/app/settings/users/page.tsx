import { SettingsNav } from '@/components/SettingsNav';
import { Shell } from '@/components/Shell';
import { UserManager } from '@/components/UserManager';
import { api, authed, type DashboardUser, type Me } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const me = await authed(() => api<Me>('/v1/me'));
  if (me.role !== 'OWNER') return <Shell me={me}><div className="empty">Hanya owner yang dapat mengelola pengguna.</div></Shell>;
  const users = await authed(() => api<DashboardUser[]>('/v1/users'));
  return (
    <Shell me={me}>
      <h1>Pengaturan</h1>
      <SettingsNav active="users" role={me.role} />
      <UserManager users={users} />
    </Shell>
  );
}
