'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { OutletSettings } from '@/lib/api';
import { manage } from '@/lib/manage';

const parseTerminals = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean);

/** Menambah outlet baru. ID dibuat server dari ID tenant dan nama, jadi owner cukup mengisi nama dan terminal. */
export function NewOutletForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [terminals, setTerminals] = useState('pos-1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <section className="panel">
      <h2>Tambah outlet</h2>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          setNotice(null);
          const r = await manage('POST', '/v1/outlets', { name, terminals: parseTerminals(terminals) });
          setBusy(false);
          if (!r.ok) return setError(r.message);
          setNotice(`Outlet ${name} dibuat. Atur pajak dan EDC-nya di bawah, lalu pasang sensor di tab Perangkat.`);
          setName('');
          router.refresh();
        }}
      >
        <label>Nama outlet<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required placeholder="Palmerah 2" /></label>
        <label>Terminal POS (pisahkan koma)<input value={terminals} onChange={(e) => setTerminals(e.target.value.toLowerCase())} placeholder="pos-1, pos-2" /></label>
        <div className="form-actions"><button type="submit" disabled={busy || !name.trim()}>Tambah</button></div>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="ok-note" role="status">{notice}</p>}
      <p className="muted small">
        Terminal adalah ID kasir/perangkat POS di outlet itu (huruf kecil, angka, - atau _). Satu sensor melayani satu terminal.
      </p>
    </section>
  );
}

/** Mengubah nama dan daftar terminal satu outlet. */
export function OutletDetailsForm({ s }: { s: OutletSettings }) {
  const router = useRouter();
  const [name, setName] = useState(s.name);
  const [terminals, setTerminals] = useState(s.terminals.join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  return (
    <form
      className="panel"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(false);
        const r = await manage('PUT', `/v1/outlets/${s.id}`, { name, terminals: parseTerminals(terminals) });
        setBusy(false);
        if (!r.ok) return setError(r.message);
        setSaved(true);
        router.refresh();
      }}
    >
      <h2>{s.name} <span className="muted small mono">{s.id}</span></h2>
      <div className="form-grid">
        <label>Nama outlet<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></label>
        <label>Terminal POS (pisahkan koma)<input value={terminals} onChange={(e) => setTerminals(e.target.value.toLowerCase())} placeholder="pos-1, pos-2" /></label>
        <div className="form-actions"><button type="submit" disabled={busy || !name.trim()}>Simpan nama &amp; terminal</button></div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {saved && <p className="ok-note" role="status">Tersimpan.</p>}
      <p className="muted small">
        Daftarkan hanya terminal yang benar-benar dipakai. Terminal yang terdaftar tetapi tidak pernah mengirim data membuat evaluasi aturan menunggu lebih lama.
        ID outlet (<span className="mono">{s.id}</span>) tidak bisa diubah.
      </p>
    </form>
  );
}
