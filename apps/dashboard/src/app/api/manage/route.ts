import { NextResponse } from 'next/server';
import { api, ApiError, sameOrigin } from '@/lib/api';

/** Hanya jalur pengelolaan yang diizinkan; peran akhirnya tetap diperiksa oleh API. */
const ALLOWED: { methods: string[]; path: RegExp }[] = [
  { methods: ['POST', 'PUT'], path: /^\/v1\/staff(\/[a-z0-9_-]+)?$/ },
  { methods: ['POST', 'PUT'], path: /^\/v1\/menu(\/[a-z0-9_-]+)?$/ },
  { methods: ['PUT'], path: /^\/v1\/menu\/[a-z0-9_-]+\/recipe$/ },
  { methods: ['POST', 'PUT'], path: /^\/v1\/promos(\/[a-z0-9_-]+)?$/ },
  { methods: ['PUT', 'DELETE'], path: /^\/v1\/menu\/[a-z0-9_-]+\/image$/ },
  { methods: ['POST', 'PUT'], path: /^\/v1\/ingredients(\/[a-z0-9_-]+)?$/ },
  { methods: ['POST'], path: /^\/v1\/outlets\/[a-z0-9_-]+\/stock\/movements$/ },
  { methods: ['POST', 'PUT'], path: /^\/v1\/outlets\/[a-z0-9_-]+\/settings$/ },
  { methods: ['POST', 'PUT'], path: /^\/v1\/outlets\/[a-z0-9_-]+\/settlements$/ },
  { methods: ['POST'], path: /^\/v1\/users$/ },
  { methods: ['PUT'], path: /^\/v1\/users\/[0-9]+$/ },
  { methods: ['POST'], path: /^\/v1\/outlets$/ },
  { methods: ['PUT'], path: /^\/v1\/outlets\/[a-z0-9_-]+$/ },
  { methods: ['POST'], path: /^\/v1\/devices\/pairing$/ },
  { methods: ['DELETE'], path: /^\/v1\/devices\/pairing\/[a-z0-9-]+$/ },
  { methods: ['POST'], path: /^\/v1\/devices\/[a-z0-9-]+\/revoke$/ },
];

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  const { method, path, body } = (await req.json().catch(() => ({}))) as { method?: string; path?: string; body?: unknown };
  if (!method || !path || !ALLOWED.some((r) => r.methods.includes(method) && r.path.test(path))) {
    return NextResponse.json({ message: 'permintaan tidak diizinkan' }, { status: 400 });
  }
  try {
    return NextResponse.json(await api(path, { method, body }));
  } catch (e) {
    if (e instanceof ApiError) return NextResponse.json({ message: e.message }, { status: e.status });
    throw e;
  }
}
