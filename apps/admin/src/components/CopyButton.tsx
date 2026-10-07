'use client';

import { useState } from 'react';

export function CopyButton({ text, label = 'Salin' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard tidak tersedia; teks tetap tampil untuk disalin manual */
        }
      }}
    >
      {done ? 'Tersalin' : label}
    </button>
  );
}
