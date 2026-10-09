import { NextResponse } from 'next/server';
import { api, ApiError, sameOrigin } from '@/lib/api';

/** Hanya jalur pengelolaan yang diizinkan; peran akhirnya tetap diperiksa oleh API. */
const ALLOWED: { methods: string[]; path: RegExp }[] = [
  { methods: ['POST', 'PUT'], path: /^\/v1\/staff(\/[a-z0-9_-]+)?$/ },
  { methods: ['POST', 'PUT'], path: /^\/v1\/menu(\/[a-z0-9_-]+)?$/ },
  { methods: ['PUT'], path: /^\/v1\/menu\/[a-z0-9_-]+\/recipe$/ },
  { methods: ['DELETE'], path: /^\/v1\/auth\/sessions\/[0-9]+$/ },
  { methods: ['POST'], path: /^\/v1\/auth\/sessions\/revoke-others$/ },
  { methods: ['POST', 'PUT'], path: /^\/v1\/promos(\/[a-z0-9_-]+)?$/ },
  { methods: ['PUT'], path: /^\/v1\/outlets\/[a-z0-9_-]+\/web-shop$/ },
  { methods: ['PUT'], path: /^\/v1\/outlets\/[a-z0-9_-]+\/queue-settings$/ },
  { methods: ['POST'], path: /^\/v1\/outlets\/[a-z0-9_-]+\/web-orders\/[0-9]+\/reject$/ },
  { methods: ['POST'], path: /^\/v1\/outlets\/[a-z0-9_-]+\/reservations$/ },
  { methods: ['PUT'], path: /^\/v1\/reservations\/[0-9]+$/ },
  { methods: ['POST'], path: /^\/v1\/reservations\/[0-9]+\/(deposit|seat|no-show|cancel|settle)$/ },
  { methods: ['PUT'], path: /^\/v1\/hr\/pay\/[a-z0-9_-]+$/ },
  { methods: ['POST'], path: /^\/v1\/outlets\/[a-z0-9_-]+\/hr\/attendance$/ },
  { methods: ['POST'], path: /^\/v1\/outlets\/[a-z0-9_-]+\/hr\/attendance\/[0-9]+\/void$/ },
  { methods: ['POST'], path: /^\/v1\/outlets\/[a-z0-9_-]+\/payroll-runs$/ },
  { methods: ['PUT'], path: /^\/v1\/payroll-runs\/[0-9]+\/lines\/[a-z0-9_-]+$/ },
  { methods: ['PUT'], path: /^\/v1\/hr\/staff-tax\/[a-z0-9_-]+$/ },
  { methods: ['PUT'], path: /^\/v1\/hr\/tax-settings$/ },
  { methods: ['PUT'], path: /^\/v1\/hr\/employer-tax$/ },
  { methods: ['POST'], path: /^\/v1\/payroll-runs\/[0-9]+\/(finalize|pay|cancel)$/ },
  { methods: ['POST', 'PUT'], path: /^\/v1\/suppliers(\/[a-z0-9_-]+)?$/ },
  { methods: ['POST'], path: /^\/v1\/suppliers\/[a-z0-9_-]+\/payments$/ },
  { methods: ['POST'], path: /^\/v1\/purchase-orders$/ },
  { methods: ['POST'], path: /^\/v1\/stock-transfers$/ },
  { methods: ['POST'], path: /^\/v1\/stock-transfers\/[0-9]+\/(receive|cancel)$/ },
  { methods: ['PUT'], path: /^\/v1\/purchase-orders\/[0-9]+$/ },
  { methods: ['POST'], path: /^\/v1\/purchase-orders\/[0-9]+\/(order|cancel|receive)$/ },
  { methods: ['POST'], path: /^\/v1\/outlets\/[a-z0-9_-]+\/online\/reports$/ },
  { methods: ['POST', 'PUT', 'DELETE'], path: /^\/v1\/outlets\/[a-z0-9_-]+\/channel-integrations(\/[A-Z]+)?$/ },
  { methods: ['PUT'], path: /^\/v1\/channel-items$/ },
  { methods: ['POST'], path: /^\/v1\/channel-items\/delete$/ },
  { methods: ['POST'], path: /^\/v1\/accounting\/accounts$/ },
  { methods: ['PUT'], path: /^\/v1\/accounting\/accounts\/[0-9]-[0-9]{4}$/ },
  { methods: ['POST'], path: /^\/v1\/outlets\/[a-z0-9_-]+\/accounting\/journal$/ },
  { methods: ['POST'], path: /^\/v1\/outlets\/[a-z0-9_-]+\/accounting\/journal\/[0-9]+\/void$/ },
  { methods: ['POST', 'PUT'], path: /^\/v1\/members(\/[a-z0-9_-]+)?$/ },
  { methods: ['PUT', 'DELETE'], path: /^\/v1\/menu\/[a-z0-9_-]+\/image$/ },
  { methods: ['POST', 'PUT'], path: /^\/v1\/ingredients(\/[a-z0-9_-]+)?$/ },
  { methods: ['PUT'], path: /^\/v1\/ingredients\/[a-z0-9_-]+\/bom$/ },
  { methods: ['POST'], path: /^\/v1\/bom\/calc$/ },
  { methods: ['POST'], path: /^\/v1\/outlets\/[a-z0-9_-]+\/paper-rolls$/ },
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
