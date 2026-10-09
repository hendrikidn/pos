import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { API_URL, sameOrigin, TOKEN_COOKIE } from '@/lib/api';

/** Keluar mencabut sesi di API (bukan sekadar menghapus cookie), supaya sesi yang sempat tersalin tidak berlaku lagi. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  if (token) await fetch(`${API_URL}/v1/admin/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, cache: 'no-store' }).catch(() => null);
  const out = NextResponse.json({ ok: true });
  out.cookies.delete(TOKEN_COOKIE);
  return out;
}
