import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { API_URL } from '@/lib/api';
import { wibDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Struk digital', robots: { index: false, follow: false } };

interface Receipt {
  ref: string;
  type: 'DINE_IN' | 'TAKE_AWAY' | 'EMPLOYEE' | null;
  table: string | null;
  issuedAt: number;
  status: 'UNPAID' | 'PARTIAL' | 'PAID' | 'VOIDED';
  items: { name: string; options: string[]; qty: number; unitPrice: number; amount: number }[];
  noItems: boolean;
  subtotal: number;
  discount: number;
  service: number;
  tax: number;
  rounding: number;
  total: number;
  paid: number;
  payments: { method: 'CASH' | 'QRIS' | 'EDC_DEBIT' | 'EDC_CREDIT' | 'PLATFORM'; amount: number; at: number }[];
  refunded: number;
  voidedAt: number | null;
}

const rp = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;
const METHOD: Record<string, string> = { CASH: 'Tunai', QRIS: 'QRIS', EDC_DEBIT: 'Kartu debit', EDC_CREDIT: 'Kartu kredit', PLATFORM: 'Platform online' };
const TYPE: Record<string, string> = { DINE_IN: 'Dine-in', TAKE_AWAY: 'Take-away', EMPLOYEE: 'Karyawan' };

/** Struk digital untuk customer: halaman publik (alamatnya token acak dari QR), tanpa login dan tanpa data pribadi. */
export default async function ReceiptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let data = null as { merchantName: string; receipt: Receipt } | null;
  let busy = false;
  try {
    // Alamat customer dari nginx diteruskan ke API: pembatas laju struk bekerja per alamat, bukan per server dashboard (yang sama untuk semua).
    const xff = (await headers()).get('x-forwarded-for');
    const res = await fetch(`${API_URL}/v1/receipts/${encodeURIComponent(token)}`, { cache: 'no-store', headers: xff ? { 'x-forwarded-for': xff } : {} });
    if (res.ok) data = (await res.json()) as { merchantName: string; receipt: Receipt };
    else busy = res.status === 429;
  } catch {
    /* server tidak terjangkau: tampil sebagai tidak ditemukan */
  }

  if (!data) {
    return (
      <main className="rcpt">
        <section className="rcpt-paper">
          <h1>{busy ? 'Terlalu banyak permintaan' : 'Struk tidak ditemukan'}</h1>
          <p className="rcpt-muted">{busy ? 'Coba lagi sebentar.' : 'Tautan struk ini tidak dikenal. Periksa kembali QR yang dipindai, atau minta struk ke kasir.'}</p>
        </section>
      </main>
    );
  }

  const r = data.receipt;
  const left = Math.max(0, r.total - r.paid);
  return (
    <main className="rcpt">
      <section className="rcpt-paper" aria-label="Struk">
        <header>
          <h1>{data.merchantName}</h1>
          <p className="rcpt-muted">
            Struk #{r.ref}{r.table ? ` · Meja ${r.table}` : r.type ? ` · ${TYPE[r.type]}` : ''}<br />{wibDateTime(r.issuedAt)}
          </p>
        </header>

        {r.status === 'VOIDED' && (
          <p className="rcpt-banner void" role="alert">
            <b>PESANAN DIBATALKAN</b>
            {r.voidedAt ? ` pada ${wibDateTime(r.voidedAt)}` : ''}. Bila Anda sudah membayar, pastikan uang Anda dikembalikan oleh kasir.
          </p>
        )}
        {r.status === 'UNPAID' && <p className="rcpt-banner warn"><b>Belum dibayar.</b></p>}
        {r.status === 'PARTIAL' && <p className="rcpt-banner warn"><b>Belum lunas.</b> Sisa {rp(left)}.</p>}

        {r.noItems ? (
          <p className="rcpt-muted">Rincian item tidak tersedia untuk pesanan ini.</p>
        ) : (
          <ul className="rcpt-items">
            {r.items.map((l, i) => (
              <li key={i}>
                <span>
                  {l.qty}× {l.name}
                  {l.options.length > 0 && <small>{l.options.join(' · ')}</small>}
                </span>
                <b>{rp(l.amount)}</b>
              </li>
            ))}
          </ul>
        )}

        <dl className="rcpt-sum">
          {!r.noItems && <div><dt>Subtotal</dt><dd>{rp(r.subtotal)}</dd></div>}
          {r.discount > 0 && <div><dt>Diskon</dt><dd>−{rp(r.discount)}</dd></div>}
          {r.service > 0 && <div><dt>Service</dt><dd>{rp(r.service)}</dd></div>}
          {r.tax > 0 && <div><dt>PBJT</dt><dd>{rp(r.tax)}</dd></div>}
          {r.rounding !== 0 && <div><dt>Pembulatan</dt><dd>{r.rounding < 0 ? '−' : ''}{rp(Math.abs(r.rounding))}</dd></div>}
          <div className="grand"><dt>Total</dt><dd>{rp(r.total)}</dd></div>
          {r.payments.map((p, i) => <div key={i}><dt>Dibayar · {METHOD[p.method]}</dt><dd>{rp(p.amount)}</dd></div>)}
          {r.refunded > 0 && <div><dt>Dikembalikan</dt><dd>−{rp(r.refunded)}</dd></div>}
        </dl>

        <p className="rcpt-muted rcpt-foot">Terima kasih. Struk ini tidak memuat data pribadi Anda.</p>
      </section>
    </main>
  );
}
