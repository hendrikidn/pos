import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { TicketView, type PublicTicket } from '@/components/QueueClient';
import { API_URL } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Tiket antrian', robots: { index: false, follow: false } };

export default async function TicketPage({ params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  let t: PublicTicket | null = null;
  try {
    const xff = (await headers()).get('x-forwarded-for');
    const res = await fetch(`${API_URL}/v1/public/queue-tickets/${encodeURIComponent(token)}`, { cache: 'no-store', headers: xff ? { 'x-forwarded-for': xff } : {} });
    if (res.ok) t = (await res.json()) as PublicTicket;
  } catch { /* tampil tidak ditemukan */ }
  if (!t) return <main className="rcpt"><section className="rcpt-paper"><h1>Tiket tidak ditemukan</h1><p className="rcpt-muted">Periksa kembali tautan Anda, atau tanyakan ke kasir.</p></section></main>;
  return <TicketView slug={slug} token={token} t={t} />;
}
