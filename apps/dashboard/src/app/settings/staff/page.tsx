import { SettingsNav } from '@/components/SettingsNav';
import { Shell } from '@/components/Shell';
import { StaffManager } from '@/components/StaffManager';
import { api, authed, type Me, type StaffRow } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function StaffPage() {
  const me = await authed(() => api<Me>('/v1/me'));
  if (me.role !== 'OWNER') return <Shell me={me}><div className="empty">Hanya owner yang dapat mengelola staf.</div></Shell>;
  const staff = await authed(() => api<StaffRow[]>('/v1/staff'));
  return (
    <Shell me={me}>
      <h1>Pengaturan</h1>
      <SettingsNav active="staff" role={me.role} />
      <StaffManager staff={staff} />
    </Shell>
  );
}
