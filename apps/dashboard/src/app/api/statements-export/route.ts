import { NextResponse } from 'next/server';
import { API_URL, getToken } from '@/lib/api';

/** Unduhan CSV satu laporan keuangan: meneruskan ke API dengan sesi login yang sama. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const outlet = u.searchParams.get('outlet') ?? '';
  const statement = u.searchParams.get('statement') ?? '';
  const from = u.searchParams.get('from') ?? '';
  const to = u.searchParams.get('to') ?? '';
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (!/^[a-z0-9_-]{1,40}$/.test(outlet) || !/^(balance|income|cashflow|equity)$/.test(statement) || !date.test(from) || !date.test(to)) return NextResponse.json({ message: 'permintaan tidak valid' }, { status: 400 });
  const token = await getToken();
  if (!token) return NextResponse.json({ message: 'belum login' }, { status: 401 });
  const res = await fetch(`${API_URL}/v1/outlets/${outlet}/accounting/statements?format=csv&statement=${statement}&from=${from}&to=${to}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) return NextResponse.json({ message: 'ekspor gagal' }, { status: res.status === 403 ? 403 : 502 });
  return new NextResponse(await res.arrayBuffer(), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': res.headers.get('content-disposition') ?? 'attachment; filename="laporan.csv"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
