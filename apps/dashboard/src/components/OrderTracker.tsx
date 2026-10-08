'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { rp } from '@/lib/format';

export interface Tracked {
  outletName: string;
  code: string;
  status: 'NEW' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
  total: number;
  type: 'TAKE_AWAY' | 'DINE_IN';
  tableNo: string | null;
  createdAt: number;
  reason: string | null;
  items: { name: string; qty: number; options: string[]; note: string | null }[];
}

const TITLE = { NEW: 'Menunggu konfirmasi kasir', ACCEPTED: 'Pesanan diterima', REJECTED: 'Pesanan ditolak', EXPIRED: 'Pesanan kedaluwarsa' } as const;

/** Status pesanan; diperbarui sendiri selama masih menunggu atau diproses. */
export function OrderTracker({ slug, data }: { slug: string; data: Tracked }) {
  const router = useRouter();
  useEffect(() => {
    if (data.status !== 'NEW') return;
    const id = setInterval(() => router.refresh(), 6_000);
    return () => clearInterval(id);
  }, [data.status, router]);
  return (
    <main className="rcpt">
      <section className="rcpt-paper" aria-label="Status pesanan">
        <header>
          <h1>{data.outletName}</h1>
          <p className="rcpt-muted">Pesanan {data.code} · {data.type === 'DINE_IN' ? `Makan di tempat, meja ${data.tableNo}` : 'Ambil sendiri'}</p>
        </header>
        <p className={`rcpt-banner ${data.status === 'ACCEPTED' ? '' : data.status === 'NEW' ? 'warn' : 'void'}`} role="status">
          <b>{TITLE[data.status]}</b>
          {data.status === 'NEW' && <><br />Kasir akan menanggapi dalam beberapa menit. Halaman ini diperbarui otomatis.</>}
          {data.status === 'ACCEPTED' && <><br />Silakan bayar di kasir saat {data.type === 'DINE_IN' ? 'pesanan diantar' : 'mengambil pesanan'}.</>}
          {data.status === 'REJECTED' && <><br />Alasan: {data.reason}. Silakan pesan langsung di kasir.</>}
          {data.status === 'EXPIRED' && <><br />Tidak ada tanggapan dari kasir. Silakan pesan ulang atau langsung di kasir.</>}
        </p>
        <ul className="shop-lines">
          {data.items.map((i, k) => (
            <li key={k}><span>{i.qty}× {i.name}{i.options.length > 0 ? ` (${i.options.join(', ')})` : ''}{i.note ? ` — ${i.note}` : ''}</span></li>
          ))}
        </ul>
        <p className="rcpt-muted">Perkiraan total {rp(data.total)} · dibayar di kasir; harga final mengikuti kasir.</p>
        <p style={{ textAlign: 'center' }}><Link href={`/shop/${slug}`}>Pesan lagi</Link></p>
      </section>
    </main>
  );
}
