import { NextResponse } from 'next/server';
import { API_URL, sameOrigin } from '@/lib/api';

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{22}$/.test(token)) return NextResponse.json({ message: 'tiket tidak ditemukan' }, { status: 404 });
  const xff = req.headers.get('x-forwarded-for');
  const res = await fetch(`${API_URL}/v1/public/queue-tickets/${token}/cancel`, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', ...(xff ? { 'x-forwarded-for': xff } : {}) }, body: '{}' }).catch(() => null);
  if (!res) return NextResponse.json({ message: 'Server tidak dapat dihubungi.' }, { status: 502 });
  if (!res.ok) { const j = (await res.json().catch(() => ({}))) as { message?: string }; return NextResponse.json({ message: j.message ?? 'Gagal membatalkan.' }, { status: res.status }); }
  return NextResponse.json({ ok: true });
}
