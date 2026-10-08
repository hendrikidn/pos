import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { ShopClient, type Shop } from '@/components/ShopClient';
import { API_URL } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Pesan online', robots: { index: false, follow: false } };

/** Toko web publik satu outlet: menu, keranjang, dan pesanan yang dibayar di kasir. Tanpa login. */
export default async function ShopPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ meja?: string }> }) {
  const { slug } = await params;
  const { meja } = await searchParams;
  let shop: Shop | null = null;
  let busy = false;
  try {
    const xff = (await headers()).get('x-forwarded-for');
    const res = await fetch(`${API_URL}/v1/public/shop/${encodeURIComponent(slug)}`, { cache: 'no-store', headers: xff ? { 'x-forwarded-for': xff } : {} });
    if (res.ok) shop = (await res.json()) as Shop;
    else busy = res.status === 429;
  } catch {
    /* server tidak terjangkau: tampil sebagai tidak ditemukan */
  }
  if (!shop) {
    return (
      <main className="rcpt">
        <section className="rcpt-paper">
          <h1>{busy ? 'Terlalu banyak permintaan' : 'Toko tidak ditemukan'}</h1>
          <p className="rcpt-muted">{busy ? 'Coba lagi sebentar.' : 'Alamat toko ini tidak dikenal atau pemesanan online sedang ditutup. Silakan pesan langsung di kasir.'}</p>
        </section>
      </main>
    );
  }
  return <ShopClient slug={slug} shop={shop} table={meja && shop.tables.includes(meja) ? meja : ''} />;
}
