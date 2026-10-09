import { NextResponse } from 'next/server';
import { API_URL, getToken } from '@/lib/api';

/** Unduhan XML Coretax (BPMP bulanan atau BPA1 tahunan); hanya owner, API memeriksa perannya dan kelengkapan data. */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const kind = sp.get('kind');
  const year = sp.get('year') ?? '';
  const month = sp.get('month') ?? '';
  if ((kind !== 'bpmp' && kind !== 'a1') || !/^\d{4}$/.test(year) || (kind === 'bpmp' && !/^(0?[1-9]|1[0-2])$/.test(month))) return NextResponse.json({ message: 'permintaan tidak valid' }, { status: 400 });
  const token = await getToken();
  if (!token) return NextResponse.json({ message: 'belum login' }, { status: 401 });
  const res = await fetch(`${API_URL}/v1/hr/tax/${kind}?year=${year}${kind === 'bpmp' ? `&month=${month}` : ''}&format=xml`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { message?: string };
    return NextResponse.json({ message: res.status === 400 ? (j.message ?? 'data belum lengkap') : 'ekspor gagal' }, { status: res.status === 400 || res.status === 403 ? res.status : 502 });
  }
  return new NextResponse(await res.arrayBuffer(), {
    headers: { 'content-type': 'application/xml; charset=utf-8', 'content-disposition': res.headers.get('content-disposition') ?? `attachment; filename="${kind}-${year}.xml"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
