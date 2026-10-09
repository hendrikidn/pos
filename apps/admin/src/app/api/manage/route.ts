import { NextResponse } from 'next/server';
import { api, ApiError, sameOrigin } from '@/lib/api';

/** Hanya jalur admin yang diizinkan; token admin diperiksa API pada setiap permintaan. */
const ALLOWED: { methods: string[]; path: RegExp }[] = [
  { methods: ['POST'], path: /^\/v1\/admin\/tenants$/ },
  { methods: ['PUT'], path: /^\/v1\/admin\/tenants\/[a-z0-9_-]+$/ },
  { methods: ['POST'], path: /^\/v1\/admin\/tenants\/[a-z0-9_-]+\/(suspend|reactivate|owner-tokens)$/ },
  { methods: ['POST'], path: /^\/v1\/admin\/tenants\/[a-z0-9_-]+\/tokens\/[0-9]+\/revoke$/ },
  { methods: ['POST'], path: /^\/v1\/admin\/tenants\/[a-z0-9_-]+\/users$/ },
  { methods: ['PUT'], path: /^\/v1\/admin\/tenants\/[a-z0-9_-]+\/subscription$/ },
  { methods: ['POST'], path: /^\/v1\/admin\/billing\/run$/ },
  { methods: ['POST'], path: /^\/v1\/admin\/billing\/invoices\/INV-[0-9]{6}-[0-9]{4}\/(pay|void)$/ },
  { methods: ['PUT'], path: /^\/v1\/admin\/plans\/[a-z0-9_-]+$/ },
  { methods: ['PUT'], path: /^\/v1\/admin\/tenants\/[a-z0-9_-]+\/users\/[0-9]+$/ },
  { methods: ['POST'], path: /^\/v1\/admin\/auth\/(2fa\/(setup|enable|disable)|sessions\/revoke-others)$/ },
  { methods: ['DELETE'], path: /^\/v1\/admin\/auth\/sessions\/[0-9]+$/ },
];

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  const { method = 'POST', path, body } = (await req.json().catch(() => ({}))) as { method?: string; path?: string; body?: unknown };
  if (!path || !ALLOWED.some((r) => r.methods.includes(method) && r.path.test(path))) return NextResponse.json({ message: 'permintaan tidak diizinkan' }, { status: 400 });
  try {
    return NextResponse.json(await api(path, { method, body: body ?? {} }));
  } catch (e) {
    if (e instanceof ApiError) return NextResponse.json({ message: e.message }, { status: e.status });
    throw e;
  }
}
