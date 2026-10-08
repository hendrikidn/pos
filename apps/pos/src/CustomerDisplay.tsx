import { useEffect, useState } from 'react';
import { Qr } from './Qr';
import { rp } from './ui';

export interface DisplayView {
  merchantName: string;
  lines: { name: string; qty: number; amount: number }[];
  totals: { subtotal: number; discount: number; tax: number; total: number };
  status: string;
  paperClaim: boolean;
  /** Alamat struk digital; bila ada, layar menampilkan QR-nya. */
  receiptUrl?: string;
}

export const DISPLAY_CHANNEL = 'pos-display';

/** Layar untuk customer (jendela kedua). Menampilkan tagihan dan nama merchant resmi, sebagai pencegah QR atau EDC palsu. */
export function CustomerDisplay() {
  const [view, setView] = useState<DisplayView | null>(null);
  useEffect(() => {
    const ch = new BroadcastChannel(DISPLAY_CHANNEL);
    ch.onmessage = (e: MessageEvent<DisplayView | null>) => setView(e.data);
    ch.postMessage({ hello: true });
    // Di Android (layar kedua), tagihan didorong oleh plugin native lewat fungsi global ini.
    (window as unknown as { __setDisplayView?: (v: DisplayView | null) => void }).__setDisplayView = (v) => setView(v);
    return () => ch.close();
  }, []);

  if (!view) return <main className="display idle"><h1>Selamat datang</h1><p>Silakan pesan di kasir.</p></main>;
  return (
    <main className="display">
      <h1>{view.merchantName}</h1>
      <ul>
        {view.lines.map((l, i) => (
          <li key={i}><span>{l.qty}× {l.name}</span><b>{rp(l.amount)}</b></li>
        ))}
      </ul>
      {view.totals.discount > 0 && <p className="row"><span>Diskon</span><b>−{rp(view.totals.discount)}</b></p>}
      {view.totals.tax > 0 && <p className="row"><span>PBJT</span><b>{rp(view.totals.tax)}</b></p>}
      <p className="row total"><span>Total</span><b>{rp(view.totals.total)}</b></p>
      {view.status === 'PAID' && <p className="thanks">Terima kasih. Pembayaran diterima.</p>}
      {view.receiptUrl && (
        <div className="display-qr">
          <Qr value={view.receiptUrl} size={220} label="Kode QR struk digital" />
          <p><b>Struk digital</b><br />Pindai dengan kamera ponsel. Tanpa nomor HP.</p>
        </div>
      )}
      {view.status !== 'PAID' && view.status !== 'DRAFT' && (
        <p className="verify">Bayar hanya ke QR atau mesin EDC resmi <b>{view.merchantName}</b>.</p>
      )}
      {view.paperClaim && <p className="verify">Kertas struk habis. Tanyakan struk digital ke kasir.</p>}
    </main>
  );
}
