import { NextResponse } from 'next/server';
import { API_URL, getToken } from '@/lib/api';

/** Unduhan CSV laporan pajak bulanan: meneruskan ke API dengan sesi login yang sama. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const outlet = url.searchParams.get('outlet') ?? '';
  const month = url.searchParams.get('month') ?? '';
  if (!/^[a-z0-9_-]{1,40}$/.test(outlet) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return NextResponse.json({ message: 'permintaan tidak valid' }, { status: 400 });
  const token = await getToken();
  if (!token) return NextResponse.json({ message: 'belum login' }, { status: 401 });
  const res = await fetch(`${API_URL}/v1/outlets/${outlet}/reports/tax?month=${month}&format=csv`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) return NextResponse.json({ message: 'ekspor gagal' }, { status: res.status === 403 ? 403 : 502 });
  return new NextResponse(await res.arrayBuffer(), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': res.headers.get('content-disposition') ?? 'attachment; filename="pajak.csv"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
