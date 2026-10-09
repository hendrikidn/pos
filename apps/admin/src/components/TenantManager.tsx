'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { TenantDetail } from '@/lib/api';
import { ago, dateWib } from '@/lib/format';
import { manage } from '@/lib/manage';
import { SecretToken } from './SecretToken';

const KIND = { sensor: 'Sensor', terminal: 'Terminal POS', kds: 'Layar dapur' } as const;

export function TenantManager({ d, now }: { d: TenantDetail; now: number }) {
  const router = useRouter();
  const tid = d.tenant.id;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ title: string; token: string } | null>(null);
  const [tok, setTok] = useState({ ownerId: 'owner', label: '' });

  async function run<T>(path: string, body: unknown, ok: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await manage<T>(path, body);
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return undefined;
    }
    setNotice(ok);
    router.refresh();
    return r.data;
  }

  const active = d.tokens.filter((t) => !t.revoked_at).length;

  return (
    <>
      {secret && <SecretToken title={secret.title} token={secret.token} />}
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="ok-note" role="status">{notice}</p>}

      <section className="panel">
        <h2>Token owner (jalur cadangan)</h2>
        <p className="muted small">Login utama memakai kode email. Token tetap berlaku sampai dicabut dan berguna sebagai cadangan atau untuk integrasi.</p>
        <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>ID</th><th>Pemilik</th><th>Keterangan</th><th>Dibuat</th><th>Status</th><th /></tr></thead>
          <tbody>
            {d.tokens.map((t) => (
              <tr key={t.id} className={t.revoked_at ? 'off' : ''}>
                <td className="mono">#{t.id}</td>
                <td>{t.user_id} · {t.role}</td>
                <td>{t.label ?? '–'}</td>
                <td>{dateWib(t.created_at)}</td>
                <td>{t.revoked_at ? `Dicabut ${dateWib(t.revoked_at)}` : 'Aktif'}</td>
                <td className="row-actions">
                  {!t.revoked_at && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        const last = active <= 1 ? ' Ini token owner terakhir yang aktif: owner tidak bisa masuk sampai Anda menerbitkan token baru.' : '';
                        if (window.confirm(`Cabut token #${t.id} (${t.user_id})? Token langsung tidak berlaku.${last}`)) {
                          void run(`/v1/admin/tenants/${tid}/tokens/${t.id}/revoke`, {}, `Token #${t.id} dicabut.`);
                        }
                      }}
                    >
                      Cabut
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {d.tokens.length === 0 && <tr><td colSpan={6} className="muted">Belum ada token.</td></tr>}
          </tbody>
        </table>
        </div>
        <h2 style={{ marginTop: 18 }}>Terbitkan token owner baru</h2>
        <form
          className="form-grid"
          onSubmit={async (e) => {
            e.preventDefault();
            setSecret(null);
            const r = await run<{ ownerToken: string; tokenId: number }>(`/v1/admin/tenants/${tid}/owner-tokens`, tok, 'Token baru diterbitkan.');
            if (r) setSecret({ title: `Token baru untuk ${tok.ownerId} (#${r.tokenId})`, token: r.ownerToken });
          }}
        >
          <label>ID owner<input value={tok.ownerId} onChange={(e) => setTok({ ...tok, ownerId: e.target.value.toLowerCase() })} maxLength={40} required /></label>
          <label>Keterangan (opsional)<input value={tok.label} onChange={(e) => setTok({ ...tok, label: e.target.value })} maxLength={80} placeholder="HP baru bu Sari" /></label>
          <div className="form-actions"><button type="submit" disabled={busy}>Terbitkan</button></div>
        </form>
      </section>

      <section className="panel">
        <h2>Perangkat</h2>
        <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>ID</th><th>Jenis</th><th>Outlet</th><th>Terminal</th><th>Terakhir terlihat</th></tr></thead>
          <tbody>
            {d.devices.map((v) => (
              <tr key={v.id} className={v.revoked_at ? 'off' : ''}>
                <td className="mono">{v.id}</td>
                <td>{KIND[v.kind]}</td>
                <td className="mono">{v.outlet_id}</td>
                <td className="mono">{v.terminal_id ?? '–'}</td>
                <td>{v.revoked_at ? 'Dicabut' : v.last_seen_ms === null ? 'Belum pernah' : ago(v.last_seen_ms, now)}{v.firmware_version && <div className="muted small">firmware {v.firmware_version}</div>}</td>
              </tr>
            ))}
            {d.devices.length === 0 && <tr><td colSpan={5} className="muted">Belum ada perangkat. Owner memasangnya sendiri di Pengaturan → Perangkat.</td></tr>}
          </tbody>
        </table>
        </div>
      </section>
    </>
  );
}
