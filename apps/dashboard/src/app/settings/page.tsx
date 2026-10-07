import { redirect } from 'next/navigation';
import { api, authed, type Me } from '@/lib/api';

export default async function SettingsIndex() {
  const me = await authed(() => api<Me>('/v1/me'));
  redirect(me.role === 'OWNER' ? '/settings/staff' : '/settings/menu');
}
