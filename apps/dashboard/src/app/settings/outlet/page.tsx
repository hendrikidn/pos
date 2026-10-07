import { NewOutletForm, OutletDetailsForm } from '@/components/OutletManager';
import { OutletSettingsForm } from '@/components/OutletSettingsForm';
import { SettingsNav } from '@/components/SettingsNav';
import { Shell } from '@/components/Shell';
import { api, authed, type Me, type Outlet, type OutletSettings } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function OutletPage() {
  const me = await authed(() => api<Me>('/v1/me'));
  if (me.role !== 'OWNER') return <Shell me={me}><div className="empty">Hanya owner yang dapat mengubah pengaturan outlet.</div></Shell>;
  const outlets = await authed(() => api<Outlet[]>('/v1/outlets'));
  const settings = await authed(() => Promise.all(outlets.map((o) => api<OutletSettings>(`/v1/outlets/${encodeURIComponent(o.id)}/settings`))));
  return (
    <Shell me={me}>
      <h1>Pengaturan</h1>
      <SettingsNav active="outlet" role={me.role} />
      <NewOutletForm />
      {settings.map((s) => (
        <div key={s.id}>
          <OutletDetailsForm s={s} />
          <OutletSettingsForm s={s} />
        </div>
      ))}
    </Shell>
  );
}
