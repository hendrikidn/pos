import Link from 'next/link';
import { BillingManager } from '@/components/BillingManager';
import { Shell } from '@/components/Shell';
import { api, authed, type AdminMe, type BillingOverview } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function BillingPage() {
  const { me, o } = await authed(async () => ({ me: await api<AdminMe>('/v1/admin/me'), o: await api<BillingOverview>('/v1/admin/billing') }));
  return (
    <Shell me={me}>
      <h1>Penagihan</h1>
      <p className="sub">Langganan per tenant. Tenant tanpa langganan (pilot) tidak ditagih; <Link href="/">buka tenant</Link> untuk memasukkannya.</p>
      <BillingManager overview={o} />
    </Shell>
  );
}
