import { NextResponse } from 'next/server';
import { API_URL, sameOrigin } from '@/lib/api';

/** Meneruskan pesanan pelanggan ke API beserta alamat klien (X-Forwarded-For), agar pembatas di API membedakan pelanggan. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  const { slug } = await params;
  if (!/^[a-z0-9][a-z0-9-]{2,29}$/.test(slug)) return NextResponse.json({ message: 'toko tidak ditemukan' }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const xff = req.headers.get('x-forwarded-for');
  const res = await fetch(`${API_URL}/v1/public/shop/${slug}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(xff ? { 'x-forwarded-for': xff } : {}) },
    // hanya isian yang dikenal; harga tidak pernah diteruskan
    body: JSON.stringify({ name: body.name, phone: body.phone, type: body.type, tableNo: body.tableNo, items: body.items, note: body.note, website: body.website }),
    cache: 'no-store',
  }).catch(() => null);
  if (!res) return NextResponse.json({ message: 'Server tidak dapat dihubungi. Coba lagi.' }, { status: 502 });
  const j = (await res.json().catch(() => ({}))) as { token?: string; code?: string; total?: number; message?: string | string[] };
  if (!res.ok) return NextResponse.json({ message: (Array.isArray(j.message) ? j.message.join('; ') : j.message) ?? 'Pesanan gagal.' }, { status: res.status });
  return NextResponse.json({ token: j.token, code: j.code, total: j.total });
}
