import Link from 'next/link';
import { api, type Billing } from '@/lib/api';
import { rp } from '@/lib/format';

/** Pengingat langganan di semua halaman untuk owner: uji coba hampir habis, tagihan menunggu, atau tertunggak. Gagal memuat = tidak tampil. */
export async function BillingBanner({ role }: { role: string }) {
  if (role !== 'OWNER') return null;
  let b: Billing;
  try {
    b = await api<Billing>('/v1/billing');
  } catch {
    return null;
  }
  const s = b.subscription;
  if (!s) return null;
  const open = b.invoices.filter((i) => i.status === 'ISSUED');
  const owed = open.reduce((a, i) => a + i.amount, 0);
  let text: string | null = null;
  let urgent = false;
  if (s.status === 'OVERDUE') { text = `Tagihan langganan ${rp(owed)} sudah lewat jatuh tempo. Segera lakukan pembayaran agar layanan tidak dihentikan.`; urgent = true; }
  else if (s.status === 'DUE') text = `Ada tagihan langganan ${rp(owed)} yang menunggu pembayaran.`;
  else if (s.status === 'TRIAL' && s.trialDaysLeft <= 7) text = `Masa uji coba berakhir dalam ${s.trialDaysLeft} hari (${s.trialEnd}).`;
  if (!text) return null;
  return (
    <div className={`notice ${urgent ? 'urgent' : ''}`} role="status" style={{ marginBottom: 16 }}>
      {text} <Link href="/settings/billing">Lihat langganan →</Link>
    </div>
  );
}
