import { NextResponse } from 'next/server';
import { API_URL, sameOrigin } from '@/lib/api';

/** Meneruskan alamat klien dari nginx agar pembatas di API membedakan pengguna, bukan menganggap semuanya berasal dari dashboard. */
const clientHeaders = (req: Request): Record<string, string> => {
  const xff = req.headers.get('x-forwarded-for');
  return xff ? { 'x-forwarded-for': xff } : {};
};

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  const { email } = (await req.json().catch(() => ({}))) as { email?: string };
  const res = await fetch(`${API_URL}/v1/auth/otp/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...clientHeaders(req) },
    body: JSON.stringify({ email }),
    cache: 'no-store',
  }).catch(() => null);
  if (!res) return NextResponse.json({ message: 'API tidak dapat dihubungi.' }, { status: 502 });
  if (res.ok) return NextResponse.json({ ok: true });
  const m = ((await res.json().catch(() => ({}))) as { message?: string | string[] }).message;
  return NextResponse.json({ message: (Array.isArray(m) ? m.join('; ') : m) ?? 'Permintaan gagal.' }, { status: res.status });
}
