import { NextResponse } from 'next/server';
import { sameOrigin } from '@/lib/api';
import { callApi, failure, unreachable } from '@/lib/session';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const r = await callApi(req, '/v1/auth/signup', {
    businessName: body.businessName, outletName: body.outletName, ownerName: body.ownerName, email: body.email, website: body.website,
  });
  if (!r) return unreachable();
  return r.ok ? NextResponse.json({ ok: true }) : failure(r, 'Pendaftaran gagal.');
}
