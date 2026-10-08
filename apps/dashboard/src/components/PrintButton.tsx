'use client';

/** Membuka dialog cetak browser; dari sana laporan bisa disimpan sebagai PDF. */
export function PrintButton({ label = 'Cetak / simpan PDF' }: { label?: string }) {
  return <button type="button" className="secondary" onClick={() => window.print()}>{label}</button>;
}
