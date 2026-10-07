import { NextResponse } from 'next/server';
import { sameOrigin } from '@/lib/api';
import { callApi, failure, unreachable } from '@/lib/session';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  const { email } = (await req.json().catch(() => ({}))) as { email?: string };
  const r = await callApi(req, '/v1/auth/password/forgot', { email });
  if (!r) return unreachable();
  return r.ok ? NextResponse.json({ ok: true }) : failure(r, 'Permintaan gagal.');
}
