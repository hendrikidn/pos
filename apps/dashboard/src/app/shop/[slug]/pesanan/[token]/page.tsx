import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { OrderTracker, type Tracked } from '@/components/OrderTracker';
import { API_URL } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Status pesanan', robots: { index: false, follow: false } };

/** Status pesanan untuk pelanggan: alamatnya token acak yang hanya diterima pemesan; tanpa nama dan nomor telepon. */
export default async function TrackPage({ params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  let data: Tracked | null = null;
  try {
    const xff = (await headers()).get('x-forwarded-for');
    const res = await fetch(`${API_URL}/v1/public/web-orders/${encodeURIComponent(token)}`, { cache: 'no-store', headers: xff ? { 'x-forwarded-for': xff } : {} });
    if (res.ok) data = (await res.json()) as Tracked;
  } catch {
    /* tampil sebagai tidak ditemukan */
  }
  if (!data) {
    return (
      <main className="rcpt">
        <section className="rcpt-paper">
          <h1>Pesanan tidak ditemukan</h1>
          <p className="rcpt-muted">Periksa kembali tautan Anda, atau tanyakan ke kasir.</p>
        </section>
      </main>
    );
  }
  return <OrderTracker slug={slug} data={data} />;
}
