import { DeviceManager } from '@/components/DeviceManager';
import { SettingsNav } from '@/components/SettingsNav';
import { Shell } from '@/components/Shell';
import { api, authed, type DeviceRow, type Me, type Outlet, type PendingPairing } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function DevicesPage() {
  const me = await authed(() => api<Me>('/v1/me'));
  if (me.role !== 'OWNER' && me.role !== 'OPS') {
    return <Shell me={me}><div className="empty">Hanya owner atau ops yang dapat mengelola perangkat.</div></Shell>;
  }
  const [outlets, devices, pending] = await authed(() =>
    Promise.all([api<Outlet[]>('/v1/outlets'), api<DeviceRow[]>('/v1/devices'), api<PendingPairing[]>('/v1/devices/pairing')]),
  );
  return (
    <Shell me={me}>
      <h1>Pengaturan</h1>
      <SettingsNav active="devices" role={me.role} />
      <DeviceManager outlets={outlets} devices={devices} pending={pending} role={me.role} now={Date.now()} />
    </Shell>
  );
}
