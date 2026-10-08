import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { QueueTake, type PublicQueue } from '@/components/QueueClient';
import { API_URL } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Antrian meja', robots: { index: false, follow: false } };

async function load(slug: string): Promise<PublicQueue | null> {
  try {
    const xff = (await headers()).get('x-forwarded-for');
    const res = await fetch(`${API_URL}/v1/public/queue/${encodeURIComponent(slug)}`, { cache: 'no-store', headers: xff ? { 'x-forwarded-for': xff } : {} });
    return res.ok ? ((await res.json()) as PublicQueue) : null;
  } catch {
    return null;
  }
}

export default async function QueuePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const board = await load(slug);
  if (!board) {
    return <main className="rcpt"><section className="rcpt-paper"><h1>Antrian tidak tersedia</h1><p className="rcpt-muted">Alamat ini tidak dikenal atau antrian online sedang ditutup. Silakan datang ke kasir.</p></section></main>;
  }
  return <QueueTake slug={slug} board={board} />;
}
