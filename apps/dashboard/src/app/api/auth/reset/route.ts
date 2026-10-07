import { NextResponse } from 'next/server';
import { sameOrigin } from '@/lib/api';
import { callApi, failure, sessionResponse, unreachable } from '@/lib/session';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  const { email, code, password } = (await req.json().catch(() => ({}))) as { email?: string; code?: string; password?: string };
  const r = await callApi(req, '/v1/auth/password/reset', { email, code, password });
  if (!r) return unreachable();
  if (!r.ok || !r.data.token) return failure(r, 'Kode salah atau sudah kedaluwarsa.');
  return sessionResponse(r.data);
}
