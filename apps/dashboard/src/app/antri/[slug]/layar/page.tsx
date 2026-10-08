import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { QueueDisplay, type PublicQueue } from '@/components/QueueClient';
import { API_URL } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Layar antrian', robots: { index: false, follow: false } };

/** Layar publik untuk TV di outlet: hanya nomor yang dipanggil dan jumlah menunggu, tanpa data pribadi. */
export default async function QueueScreen({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let board: PublicQueue | null = null;
  try {
    const xff = (await headers()).get('x-forwarded-for');
    const res = await fetch(`${API_URL}/v1/public/queue/${encodeURIComponent(slug)}`, { cache: 'no-store', headers: xff ? { 'x-forwarded-for': xff } : {} });
    if (res.ok) board = (await res.json()) as PublicQueue;
  } catch { /* tampil tidak tersedia */ }
  if (!board) return <main className="rcpt"><section className="rcpt-paper"><h1>Antrian tidak tersedia</h1></section></main>;
  return <QueueDisplay board={board} />;
}
