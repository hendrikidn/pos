import { NextResponse } from 'next/server';
import { getToken, sameOrigin } from '@/lib/api';
import { callApi, failure, unreachable } from '@/lib/session';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  const token = await getToken();
  if (!token) return NextResponse.json({ message: 'belum login' }, { status: 401 });
  const { current, password } = (await req.json().catch(() => ({}))) as { current?: string; password?: string };
  const r = await callApi(req, '/v1/auth/password/change', { current, password }, token);
  if (!r) return unreachable();
  return r.ok ? NextResponse.json({ ok: true }) : failure(r, 'Gagal mengganti password.');
}
