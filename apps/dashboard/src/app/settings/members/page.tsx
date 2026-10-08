import { MemberManager } from '@/components/MemberManager';
import { SettingsNav } from '@/components/SettingsNav';
import { Shell } from '@/components/Shell';
import { api, authed, type MemberRow, type Me } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function MembersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const me = await authed(() => api<Me>('/v1/me'));
  if (me.role !== 'OWNER' && me.role !== 'OPS') return <Shell me={me}><div className="empty">Hanya owner atau ops yang dapat mengelola member.</div></Shell>;
  const members = await authed(() => api<MemberRow[]>(`/v1/members${q ? `?search=${encodeURIComponent(q)}` : ''}`));
  return (
    <Shell me={me}>
      <h1>Pengaturan</h1>
      <SettingsNav active="members" role={me.role} />
      <MemberManager members={members} query={q ?? ''} />
    </Shell>
  );
}
