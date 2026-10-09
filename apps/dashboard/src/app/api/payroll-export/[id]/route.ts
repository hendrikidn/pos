import { NextResponse } from 'next/server';
import { API_URL, getToken } from '@/lib/api';

/** Unduhan CSV slip gaji (hanya owner; API memeriksa perannya). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const statutory = new URL(req.url).searchParams.get('kind') === 'statutory';
  if (!/^[0-9]{1,9}$/.test(id)) return NextResponse.json({ message: 'id tidak valid' }, { status: 400 });
  const token = await getToken();
  if (!token) return NextResponse.json({ message: 'belum login' }, { status: 401 });
  const res = await fetch(`${API_URL}/v1/payroll-runs/${id}/${statutory ? 'export-statutory' : 'export'}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) return NextResponse.json({ message: 'ekspor gagal' }, { status: res.status === 403 ? 403 : 502 });
  return new NextResponse(await res.arrayBuffer(), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': res.headers.get('content-disposition') ?? 'attachment; filename="gaji.csv"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
