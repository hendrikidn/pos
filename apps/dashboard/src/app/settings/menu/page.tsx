import { MenuImport } from '@/components/MenuImport';
import { MenuManager } from '@/components/MenuManager';
import { SettingsNav } from '@/components/SettingsNav';
import { Shell } from '@/components/Shell';
import { api, authed, type MenuCostRow, type MenuRow, type Me } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function MenuPage() {
  const me = await authed(() => api<Me>('/v1/me'));
  if (me.role !== 'OWNER' && me.role !== 'OPS') return <Shell me={me}><div className="empty">Hanya owner atau ops yang dapat mengelola menu.</div></Shell>;
  const items = await authed(() => api<MenuRow[]>('/v1/menu'));
  const costs = await authed(() => api<MenuCostRow[]>('/v1/menu-cost').catch(() => [] as MenuCostRow[]));
  return (
    <Shell me={me}>
      <h1>Pengaturan</h1>
      <SettingsNav active="menu" role={me.role} />
      <MenuManager items={items} costs={costs} />
      <MenuImport />
    </Shell>
  );
}
