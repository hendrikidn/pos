import { NextResponse } from 'next/server';
import { API_URL, sameOrigin, TOKEN_COOKIE } from '@/lib/api';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  const { email, code } = (await req.json().catch(() => ({}))) as { email?: string; code?: string };
  const xff = req.headers.get('x-forwarded-for');
  const res = await fetch(`${API_URL}/v1/auth/otp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(xff ? { 'x-forwarded-for': xff } : {}) },
    body: JSON.stringify({ email, code }),
    cache: 'no-store',
  }).catch(() => null);
  if (!res) return NextResponse.json({ message: 'API tidak dapat dihubungi.' }, { status: 502 });
  const body = (await res.json().catch(() => ({}))) as { token?: string; role?: string; expiresAt?: string; message?: string | string[] };
  if (!res.ok || !body.token) {
    const m = Array.isArray(body.message) ? body.message.join('; ') : body.message;
    return NextResponse.json({ message: m ?? 'Kode salah atau sudah kedaluwarsa.' }, { status: res.status === 201 ? 400 : res.status });
  }
  // Token sesi hanya disimpan di cookie httpOnly; JavaScript di browser tidak pernah melihatnya.
  const out = NextResponse.json({ ok: true, role: body.role });
  const maxAge = Math.max(60, Math.floor((Date.parse(body.expiresAt ?? '') - Date.now()) / 1000) || 7 * 24 * 3600);
  out.cookies.set(TOKEN_COOKIE, body.token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge });
  return out;
}
