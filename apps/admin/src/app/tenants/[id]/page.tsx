import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Shell } from '@/components/Shell';
import { TenantManager } from '@/components/TenantManager';
import { api, ApiError, authed, type AdminMe, type TenantDetail } from '@/lib/api';
import { dateWib } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function TenantPage({ params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);
  const { me, d } = await authed(async () => {
    const me = await api<AdminMe>('/v1/admin/me');
    try {
      return { me, d: await api<TenantDetail>(`/v1/admin/tenants/${encodeURIComponent(id)}`) };
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) notFound();
      throw e;
    }
  });
  return (
    <Shell me={me}>
      <Link href="/" className="back">← Semua tenant</Link>
      <h1>{d.tenant.name}</h1>
      <p className="sub"><span className="mono">{d.tenant.id}</span> · dibuat {dateWib(d.tenant.created_at)}</p>
      <TenantManager d={d} now={Date.now()} />
    </Shell>
  );
}
