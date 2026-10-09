import { NextResponse } from 'next/server';
import { API_URL, sameOrigin, TOKEN_COOKIE } from '@/lib/api';

/** Menukar token admin (dan kode 2 langkah bila perlu) dengan SESI 12 jam. Cookie hanya memegang sesi, bukan token admin yang panjang-umur. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  const { token, code } = (await req.json().catch(() => ({}))) as { token?: string; code?: string };
  if (!token || !token.startsWith('adm_')) {
    return NextResponse.json({ message: 'Token tidak valid. Token admin diawali "adm_".' }, { status: 400 });
  }
  const xff = req.headers.get('x-forwarded-for');
  const real = req.headers.get('x-real-ip');
  const res = await fetch(`${API_URL}/v1/admin/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(xff ? { 'x-forwarded-for': xff } : real ? { 'x-forwarded-for': real } : {}),
      'user-agent': req.headers.get('user-agent') ?? '',
    },
    body: JSON.stringify({ token, ...(code ? { code } : {}) }),
    cache: 'no-store',
  }).catch(() => null);
  if (!res) return NextResponse.json({ message: 'API tidak dapat dihubungi.' }, { status: 502 });
  const j = (await res.json().catch(() => ({}))) as { message?: string | string[]; needs2fa?: boolean; token?: string; expiresAt?: string };
  if (!res.ok || !j.token) {
    const m = Array.isArray(j.message) ? j.message.join('; ') : j.message;
    return NextResponse.json({ message: m ?? 'Login gagal.', needs2fa: j.needs2fa === true }, { status: res.status >= 400 ? res.status : 401 });
  }

  const out = NextResponse.json({ ok: true });
  out.cookies.set(TOKEN_COOKIE, j.token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.max(60, Math.floor((Date.parse(j.expiresAt ?? '') - Date.now()) / 1000) || 12 * 3600),
  });
  return out;
}
