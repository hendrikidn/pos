import { NextResponse } from 'next/server';
import { sameOrigin, TOKEN_COOKIE } from '@/lib/api';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  const out = NextResponse.json({ ok: true });
  out.cookies.delete(TOKEN_COOKIE);
  return out;
}
