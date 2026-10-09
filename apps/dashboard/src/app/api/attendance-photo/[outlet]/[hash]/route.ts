import { NextResponse } from 'next/server';
import { API_URL, getToken } from '@/lib/api';

/** Foto absen untuk owner dan manager: diambil dari API dengan token sesi (cookie httpOnly), tidak pernah publik. */
export async function GET(_req: Request, { params }: { params: Promise<{ outlet: string; hash: string }> }) {
  const { outlet, hash } = await params;
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(outlet) || !/^[0-9a-f]{64}$/.test(hash)) return NextResponse.json({ message: 'tidak valid' }, { status: 400 });
  const token = await getToken();
  if (!token) return NextResponse.json({ message: 'belum login' }, { status: 401 });
  const res = await fetch(`${API_URL}/v1/outlets/${outlet}/attendance-photos/${hash}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) return NextResponse.json({ message: 'foto tidak tersedia' }, { status: res.status === 404 ? 404 : res.status === 403 ? 403 : 502 });
  return new NextResponse(await res.arrayBuffer(), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' } });
}
