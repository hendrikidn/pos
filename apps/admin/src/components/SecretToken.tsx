'use client';

import { CopyButton } from './CopyButton';

/** Menampilkan token polos satu kali. Setelah halaman ditutup, token tidak bisa dilihat lagi; hanya bisa diterbitkan ulang. */
export function SecretToken({ title, token, children }: { title: string; token: string; children?: React.ReactNode }) {
  return (
    <section className="panel secret" role="status" aria-live="polite">
      <h2>{title}</h2>
      <p className="muted small">Salin dan berikan ke pemiliknya sekarang. Token <strong>tidak akan ditampilkan lagi</strong>; bila hilang, terbitkan token baru.</p>
      <code className="token mono">{token}</code>
      <CopyButton text={token} label="Salin token" />
      {children}
    </section>
  );
}
