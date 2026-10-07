import { NextResponse } from 'next/server';
import { API_URL, TOKEN_COOKIE } from './api';

export interface SessionBody {
  token?: string;
  role?: string;
  expiresAt?: string;
  message?: string | string[];
}

/** Meneruskan permintaan publik ke API beserta alamat klien dari nginx (X-Forwarded-For), agar pembatas di API membedakan pengguna. */
export async function callApi(req: Request, path: string, body: unknown, token?: string): Promise<{ status: number; ok: boolean; data: SessionBody } | null> {
  const xff = req.headers.get('x-forwarded-for');
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(xff ? { 'x-forwarded-for': xff } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    cache: 'no-store',
  }).catch(() => null);
  if (!res) return null;
  return { status: res.status, ok: res.ok, data: (await res.json().catch(() => ({}))) as SessionBody };
}

export const unreachable = () => NextResponse.json({ message: 'API tidak dapat dihubungi.' }, { status: 502 });

export function failure(r: { status: number; data: SessionBody }, fallback: string) {
  const m = Array.isArray(r.data.message) ? r.data.message.join('; ') : r.data.message;
  return NextResponse.json({ message: m ?? fallback }, { status: r.status >= 400 ? r.status : 400 });
}

/** Token sesi hanya disimpan di cookie httpOnly; JavaScript di browser tidak pernah melihatnya. */
export function sessionResponse(data: SessionBody) {
  const out = NextResponse.json({ ok: true, role: data.role });
  const maxAge = Math.max(60, Math.floor((Date.parse(data.expiresAt ?? '') - Date.now()) / 1000) || 7 * 24 * 3600);
  out.cookies.set(TOKEN_COOKIE, data.token!, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge });
  return out;
}
