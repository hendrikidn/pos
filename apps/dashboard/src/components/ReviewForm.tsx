'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { REVIEW_OPTIONS } from '@/lib/format';

export function ReviewForm({ incidentId, current }: { incidentId: string; current?: string }) {
  const router = useRouter();
  const [label, setLabel] = useState<string>(current ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!label) return setError('Pilih hasil review terlebih dahulu.');
    setBusy(true);
    setError(null);
    const res = await fetch('/api/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: incidentId, label, note: note.trim() || undefined }),
    }).catch(() => null);
    setBusy(false);
    if (!res) return setError('Tidak dapat menghubungi server.');
    if (!res.ok) return setError(((await res.json().catch(() => ({}))) as { message?: string }).message ?? 'Review gagal disimpan.');
    setNote('');
    router.refresh();
  }

  return (
    <form className="review" onSubmit={submit}>
      <fieldset>
        <legend className="sr-only">Hasil review</legend>
        {REVIEW_OPTIONS.map((o) => (
          <label className="opt" key={o.value}>
            <input type="radio" name="label" value={o.value} checked={label === o.value} onChange={() => setLabel(o.value)} />
            <span>
              {o.label}
              <small>{o.hint}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <label htmlFor="note" className="sub" style={{ display: 'block', margin: '0 0 6px' }}>
        Catatan (mis. jam rekaman yang diperiksa)
      </label>
      <textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      {error && <p className="error" role="alert">{error}</p>}
      <p style={{ margin: '12px 0 0' }}>
        <button type="submit" disabled={busy}>{busy ? 'Menyimpan…' : 'Simpan review'}</button>
      </p>
    </form>
  );
}
