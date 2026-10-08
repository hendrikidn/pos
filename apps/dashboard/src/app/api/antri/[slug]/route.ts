import { NextResponse } from 'next/server';
import { API_URL, sameOrigin } from '@/lib/api';

/** Pelanggan mengambil nomor antrian: diteruskan ke API beserta alamat klien (X-Forwarded-For) agar pembatas membedakan pelanggan. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  const { slug } = await params;
  if (!/^[a-z0-9][a-z0-9-]{2,29}$/.test(slug)) return NextResponse.json({ message: 'antrian tidak ditemukan' }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const xff = req.headers.get('x-forwarded-for');
  const res = await fetch(`${API_URL}/v1/public/queue/${slug}/tickets`, {
    method: 'POST', cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(xff ? { 'x-forwarded-for': xff } : {}) },
    body: JSON.stringify({ partySize: body.partySize, name: body.name || undefined, phone: body.phone || undefined, website: body.website }),
  }).catch(() => null);
  if (!res) return NextResponse.json({ message: 'Server tidak dapat dihubungi. Coba lagi.' }, { status: 502 });
  const j = (await res.json().catch(() => ({}))) as { token?: string; message?: string | string[] };
  if (!res.ok) return NextResponse.json({ message: (Array.isArray(j.message) ? j.message.join('; ') : j.message) ?? 'Gagal mengambil nomor.' }, { status: res.status });
  return NextResponse.json({ token: j.token });
}
