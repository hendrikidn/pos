import { NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api';

/** Foto menu untuk halaman dashboard (<img>): sesi login yang sama, tanpa membuka API langsung ke browser. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-z0-9_-]{1,32}$/.test(id)) return new NextResponse(null, { status: 400 });
  try {
    const img = await api<{ contentType: string; version: string; data: string }>(`/v1/menu/${id}/image`);
    return new NextResponse(Buffer.from(img.data, 'base64'), {
      headers: {
        'content-type': img.contentType,
        // Alamat memuat versi (?v=), jadi aman di-cache lama; `nosniff` agar isi tidak pernah dianggap jenis lain.
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (e) {
    if (e instanceof ApiError) return new NextResponse(null, { status: e.status === 401 ? 401 : 404 });
    throw e;
  }
}
