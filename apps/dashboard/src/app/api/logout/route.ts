import { NextResponse } from 'next/server';
import { API_URL, getToken, sameOrigin, TOKEN_COOKIE } from '@/lib/api';
import { LEGACY_TOKEN_COOKIE } from '@/lib/cookie';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  // Sesi email dicabut di server (token tetap dari admin tidak terpengaruh). Kegagalan di sini tidak boleh menahan keluar.
  const token = await getToken();
  if (token) {
    await fetch(`${API_URL}/v1/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, cache: 'no-store' }).catch(() => null);
  }
  const out = NextResponse.json({ ok: true });
  out.cookies.delete(TOKEN_COOKIE);
  out.cookies.delete(LEGACY_TOKEN_COOKIE);
  return out;
}
