import { NextResponse } from 'next/server';
import { API_URL, sameOrigin, TOKEN_COOKIE } from '@/lib/api';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  const { token } = (await req.json().catch(() => ({}))) as { token?: string };
  if (!token || !token.startsWith('api_')) {
    return NextResponse.json({ message: 'Token tidak valid. Token pengguna diawali "api_".' }, { status: 400 });
  }
  const res = await fetch(`${API_URL}/v1/me`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' }).catch(() => null);
  if (!res) return NextResponse.json({ message: 'API tidak dapat dihubungi.' }, { status: 502 });
  if (!res.ok) return NextResponse.json({ message: 'Token tidak dikenal.' }, { status: 401 });

  const out = NextResponse.json({ ok: true });
  out.cookies.set(TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 7 * 24 * 3600,
  });
  return out;
}
