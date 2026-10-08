import { PromoManager } from '@/components/PromoManager';
import { SettingsNav } from '@/components/SettingsNav';
import { Shell } from '@/components/Shell';
import { api, authed, type Me, type Outlet, type PromoRow } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function PromosPage() {
  const me = await authed(() => api<Me>('/v1/me'));
  if (me.role !== 'OWNER' && me.role !== 'OPS') return <Shell me={me}><div className="empty">Hanya owner atau ops yang dapat mengelola promo.</div></Shell>;
  const { promos, outlets } = await authed(async () => ({ promos: await api<PromoRow[]>('/v1/promos'), outlets: await api<Outlet[]>('/v1/outlets') }));
  return (
    <Shell me={me}>
      <h1>Pengaturan</h1>
      <SettingsNav active="promos" role={me.role} />
      <PromoManager promos={promos} outlets={outlets} />
    </Shell>
  );
}
