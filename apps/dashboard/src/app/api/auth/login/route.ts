import { NextResponse } from 'next/server';
import { sameOrigin } from '@/lib/api';
import { callApi, failure, sessionResponse, unreachable } from '@/lib/session';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  const { email, password } = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  const r = await callApi(req, '/v1/auth/login', { email, password });
  if (!r) return unreachable();
  if (!r.ok || !r.data.token) return failure(r, 'Email atau password salah.');
  return sessionResponse(r.data);
}
