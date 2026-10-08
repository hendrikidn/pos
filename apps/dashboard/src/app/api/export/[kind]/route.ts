import { NextResponse } from 'next/server';
import { API_URL, getToken } from '@/lib/api';

const KINDS = ['transactions', 'payments', 'items', 'exceptions', 'daily', 'journal'];

/** Unduhan CSV penjualan: meneruskan ke API dengan sesi login yang sama, tanpa membuka token ke browser. */
export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  const url = new URL(req.url);
  const outlet = url.searchParams.get('outlet') ?? '';
  const range = url.searchParams.get('range') ?? '7d';
  if (!KINDS.includes(kind) || !/^[a-z0-9_-]{1,40}$/.test(outlet) || !/^(today|yesterday|7d|30d|month)$/.test(range)) {
    return NextResponse.json({ message: 'permintaan ekspor tidak valid' }, { status: 400 });
  }
  const token = await getToken();
  if (!token) return NextResponse.json({ message: 'belum login' }, { status: 401 });
  const path = kind === 'journal' ? `/v1/outlets/${outlet}/accounting/export` : `/v1/outlets/${outlet}/exports/${kind}`;
  const res = await fetch(`${API_URL}${path}?range=${range}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) return NextResponse.json({ message: 'ekspor gagal' }, { status: res.status === 403 ? 403 : 502 });
  return new NextResponse(await res.arrayBuffer(), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': res.headers.get('content-disposition') ?? 'attachment; filename="ekspor.csv"',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
