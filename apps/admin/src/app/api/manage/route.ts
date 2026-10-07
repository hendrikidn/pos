import { NextResponse } from 'next/server';
import { api, ApiError, sameOrigin } from '@/lib/api';

/** Hanya jalur admin yang diizinkan; token admin diperiksa API pada setiap permintaan. Semuanya POST. */
const ALLOWED = [
  /^\/v1\/admin\/tenants$/,
  /^\/v1\/admin\/tenants\/[a-z0-9_-]+\/outlets$/,
  /^\/v1\/admin\/tenants\/[a-z0-9_-]+\/owner-tokens$/,
  /^\/v1\/admin\/tenants\/[a-z0-9_-]+\/tokens\/[0-9]+\/revoke$/,
];

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  const { path, body } = (await req.json().catch(() => ({}))) as { path?: string; body?: unknown };
  if (!path || !ALLOWED.some((r) => r.test(path))) return NextResponse.json({ message: 'permintaan tidak diizinkan' }, { status: 400 });
  try {
    return NextResponse.json(await api(path, { method: 'POST', body: body ?? {} }));
  } catch (e) {
    if (e instanceof ApiError) return NextResponse.json({ message: e.message }, { status: e.status });
    throw e;
  }
}
