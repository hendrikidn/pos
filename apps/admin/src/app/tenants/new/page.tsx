import { NewTenantForm } from '@/components/NewTenantForm';
import { Shell } from '@/components/Shell';
import { api, authed, type AdminMe } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function NewTenantPage() {
  const me = await authed(() => api<AdminMe>('/v1/admin/me'));
  const dashboardUrl = process.env.DASHBOARD_URL ?? 'https://pos.dolanyu.com';
  return (
    <Shell me={me}>
      <h1>Tenant baru</h1>
      <p className="sub">Membuat tenant, outlet pertama, dan token owner sekaligus.</p>
      <NewTenantForm dashboardUrl={dashboardUrl} />
    </Shell>
  );
}
