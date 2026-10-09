import { FirmwareManager } from '@/components/FirmwareManager';
import { Shell } from '@/components/Shell';
import { api, authed, type AdminMe, type FirmwareRelease } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function FirmwarePage() {
  const { me, releases } = await authed(async () => ({ me: await api<AdminMe>('/v1/admin/me'), releases: await api<FirmwareRelease[]>('/v1/admin/firmware') }));
  return (
    <Shell me={me}>
      <h1>Firmware sensor</h1>
      <p className="sub">Rilis yang ditawarkan ke sensor saat konfigurasi awal dan secara berkala. Hanya rilis bertanda tangan kunci rilis yang diterima server dan dipasang sensor.</p>
      <FirmwareManager releases={releases} />
    </Shell>
  );
}
