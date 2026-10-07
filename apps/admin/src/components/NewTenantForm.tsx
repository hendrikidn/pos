'use client';

import Link from 'next/link';
import { useState } from 'react';
import { manage } from '@/lib/manage';
import { SecretToken } from './SecretToken';

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

interface Created {
  tenantId: string;
  outletId: string;
  ownerId: string;
  ownerToken: string;
}

export function NewTenantForm({ dashboardUrl }: { dashboardUrl: string }) {
  const [f, setF] = useState({ tenantName: '', tenantId: '', outletName: '', outletId: '', terminals: 'pos-1', ownerId: 'owner' });
  // ID mengikuti nama selama belum diubah sendiri.
  const [edited, setEdited] = useState({ tenantId: false, outletId: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const setName = (k: 'tenantName' | 'outletName', v: string) =>
    setF((p) => {
      const n = { ...p, [k]: v };
      if (!edited.tenantId) n.tenantId = slug(n.tenantName);
      if (!edited.outletId) n.outletId = n.tenantId && n.outletName ? `${n.tenantId}-${slug(n.outletName)}`.slice(0, 40) : '';
      return n;
    });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const terminals = f.terminals.split(',').map((t) => t.trim()).filter(Boolean);
    const r = await manage<Created>('/v1/admin/tenants', { ...f, terminals });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setCreated(r.data);
  }

  if (created) {
    return (
      <>
        <SecretToken title={`Tenant "${created.tenantId}" dibuat`} token={created.ownerToken}>
          <p className="muted small" style={{ marginTop: 12 }}>
            Owner (<span className="mono">{created.ownerId}</span>) masuk ke <a href={dashboardUrl}>{dashboardUrl}</a> dengan token ini, lalu menambah staf, menu, dan memasang sensor di Pengaturan.
          </p>
        </SecretToken>
        <p><Link href={`/tenants/${created.tenantId}`}>Buka tenant →</Link> · <Link href="/tenants/new" onClick={() => location.assign('/tenants/new')}>Buat tenant lain</Link></p>
      </>
    );
  }

  return (
    <section className="panel">
      <form className="form-grid" onSubmit={submit}>
        <label>Nama tenant (usaha)<input value={f.tenantName} onChange={(e) => setName('tenantName', e.target.value)} maxLength={80} required placeholder="Kopi Senopati" /></label>
        <label>ID tenant<input value={f.tenantId} onChange={(e) => { setEdited({ ...edited, tenantId: true }); setF({ ...f, tenantId: e.target.value.toLowerCase() }); }} maxLength={40} required placeholder="kopi-senopati" /></label>
        <label>Nama outlet pertama<input value={f.outletName} onChange={(e) => setName('outletName', e.target.value)} maxLength={80} required placeholder="Senopati" /></label>
        <label>ID outlet (unik di seluruh platform)<input value={f.outletId} onChange={(e) => { setEdited({ ...edited, outletId: true }); setF({ ...f, outletId: e.target.value.toLowerCase() }); }} maxLength={40} required /></label>
        <label>Terminal POS (pisahkan koma)<input value={f.terminals} onChange={(e) => setF({ ...f, terminals: e.target.value.toLowerCase() })} placeholder="pos-1, pos-2" /></label>
        <label>ID owner<input value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value.toLowerCase() })} maxLength={40} required /></label>
        <div className="form-actions"><button type="submit" disabled={busy}>{busy ? 'Membuat…' : 'Buat tenant'}</button></div>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="muted small">ID hanya huruf kecil, angka, - atau _ (2–40 karakter) dan tidak bisa diubah setelah dibuat.</p>
    </section>
  );
}
