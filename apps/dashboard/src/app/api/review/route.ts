import { NextResponse } from 'next/server';
import { api, ApiError, sameOrigin } from '@/lib/api';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'asal permintaan tidak sah' }, { status: 403 });
  const { id, label, note } = (await req.json().catch(() => ({}))) as { id?: string; label?: string; note?: string };
  if (!id || !label) return NextResponse.json({ message: 'id dan label wajib' }, { status: 400 });
  try {
    const result = await api(`/v1/incidents/${encodeURIComponent(id)}/review`, { method: 'POST', body: { label, note } });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ApiError) return NextResponse.json({ message: e.message }, { status: e.status });
    throw e;
  }
}
