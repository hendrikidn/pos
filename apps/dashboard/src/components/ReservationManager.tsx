'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ReservationList, ReservationRow, ReservationStatus } from '@/lib/api';
import { manage } from '@/lib/manage';
import { rp, weekdayDate } from '@/lib/format';

const STATUS: Record<ReservationStatus, string> = { BOOKED: 'Dipesan', SEATED: 'Sudah duduk', NO_SHOW: 'Tidak datang', CANCELED: 'Dibatalkan' };
const wib = (ms: number) => new Date(ms + 7 * 3_600_000).toISOString();
const dateOf = (ms: number) => wib(ms).slice(0, 10);
const timeOf = (ms: number) => wib(ms).slice(11, 16);
const NO_SHOW_GRACE_MS = 15 * 60_000;
const emptyForm = (): Form => ({ id: null, guestName: '', phone: '', partySize: '2', date: dateOf(Date.now()), time: '19:00', durationMin: '90', tableNo: '', note: '' });
interface Form { id: number | null; guestName: string; phone: string; partySize: string; date: string; time: string; durationMin: string; tableNo: string; note: string }

export function ReservationManager({ outletId, list }: { outletId: string; list: ReservationList }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [f, setF] = useState<Form>(emptyForm());
  const now = Date.now();

  async function act(fn: () => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>, ok?: (d: unknown) => string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) return void setError(r.message);
    if (ok) setNotice(ok(r.data));
    router.refresh();
    return r;
  }

  const byDay = new Map<string, ReservationRow[]>();
  for (const r of list.reservations) (byDay.get(dateOf(r.start)) ?? byDay.set(dateOf(r.start), []).get(dateOf(r.start))!).push(r);

  function edit(r: ReservationRow) {
    setF({ id: r.id, guestName: r.guestName, phone: r.phone ?? '', partySize: String(r.partySize), date: dateOf(r.start), time: timeOf(r.start), durationMin: String(r.durationMin), tableNo: r.tableNo ?? '', note: r.note ?? '' });
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  function body() {
    return {
      guestName: f.guestName, phone: f.phone || undefined, partySize: Number(f.partySize), start: Date.parse(`${f.date}T${f.time}:00+07:00`),
      durationMin: Number(f.durationMin), tableNo: f.tableNo || undefined, note: f.note || undefined,
    };
  }

  return (
    <>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="ok-note" role="status">{notice}</p>}
      {list.reservations.length === 0 && <section className="panel"><p className="muted" style={{ margin: 0 }}>Belum ada reservasi pada rentang ini.</p></section>}
      {[...byDay].map(([day, rows]) => (
        <section key={day} className="panel">
          <h2>{weekdayDate(day)}</h2>
          <table className="table">
            <thead><tr><th>Jam</th><th>Tamu</th><th className="num">Orang</th><th>Meja</th><th>Status</th><th>Uang muka</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => {
                const settleable = r.deposit > 0 && !r.settle && r.remaining > 0;
                return (
                  <tr key={r.id} className={r.status === 'CANCELED' || r.status === 'NO_SHOW' ? 'off' : ''}>
                    <td data-label="Jam">{timeOf(r.start)}–{timeOf(r.start + r.durationMin * 60_000)}</td>
                    <td data-label="Tamu">{r.guestName}<div className="muted small">{r.phone ?? '–'}{r.note ? ` · ${r.note}` : ''}</div></td>
                    <td data-label="Orang" className="num">{r.partySize}</td>
                    <td data-label="Meja">{r.tableNo ?? <span className="muted">belum</span>}</td>
                    <td data-label="Status">{STATUS[r.status]}{r.statusReason && <div className="muted small">{r.statusReason}</div>}</td>
                    <td data-label="Uang muka">
                      {r.deposit > 0 ? (
                        <>
                          {rp(r.deposit)} <span className="muted small">{r.depositMethod === 'CASH' ? 'tunai' : 'transfer'} · oleh {r.depositBy}</span>
                          <div className="small">{r.applied > 0 && <>terpakai {rp(r.applied)} · </>}
                            {r.settle ? <span className="muted">{r.settle.kind === 'REFUND' ? 'dikembalikan' : 'hangus'} {rp(r.settle.amount)} oleh {r.settle.by}</span> : <b>sisa {rp(r.remaining)}</b>}</div>
                        </>
                      ) : <span className="muted">–</span>}
                    </td>
                    <td className="row-actions">
                      {r.status === 'BOOKED' && (
                        <>
                          <button className="secondary" disabled={busy} onClick={() => edit(r)}>Ubah</button>
                          {r.deposit === 0 && <button className="secondary" disabled={busy} onClick={() => {
                            const amount = window.prompt('Jumlah uang muka (rupiah):');
                            if (!amount) return;
                            const m = (window.prompt('Diterima lewat TUNAI atau TRANSFER?', 'TUNAI') ?? '').trim().toUpperCase();
                            if (m !== 'TUNAI' && m !== 'TRANSFER') return void setError('Metode harus TUNAI atau TRANSFER.');
                            void act(() => manage('POST', `/v1/reservations/${r.id}/deposit`, { amount: Number(amount.replace(/\D/g, '')), method: m === 'TUNAI' ? 'CASH' : 'TRANSFER' }), () => 'Uang muka dicatat.');
                          }}>Uang muka</button>}
                          <button disabled={busy} onClick={() => void act(() => manage('POST', `/v1/reservations/${r.id}/seat`), () => 'Tamu didudukkan.')}>Duduk</button>
                          <button className="secondary" disabled={busy || now < r.start + NO_SHOW_GRACE_MS} title={now < r.start + NO_SHOW_GRACE_MS ? 'Baru bisa 15 menit setelah jam reservasi' : undefined} onClick={() => void act(() => manage('POST', `/v1/reservations/${r.id}/no-show`), () => 'Ditandai tidak datang.')}>Tidak datang</button>
                          <button className="secondary" disabled={busy} onClick={() => { const reason = window.prompt('Alasan pembatalan:'); if (reason) void act(() => manage('POST', `/v1/reservations/${r.id}/cancel`, { reason }), () => 'Reservasi dibatalkan.'); }}>Batalkan</button>
                        </>
                      )}
                      {settleable && r.status !== 'BOOKED' && (
                        <>
                          <button className="secondary" disabled={busy} onClick={() => { const reason = window.prompt(`Alasan mengembalikan ${rp(r.remaining)} ke tamu:`); if (reason) void act(() => manage('POST', `/v1/reservations/${r.id}/settle`, { kind: 'REFUND', reason }), (d) => `Uang muka ${rp((d as { amount: number }).amount)} dikembalikan.`); }}>Kembalikan</button>
                          {(r.status === 'NO_SHOW' || r.status === 'CANCELED') && (
                            <button className="secondary" disabled={busy} onClick={() => { if (!window.confirm(`Hanguskan uang muka ${rp(r.remaining)}? Dicatat sebagai pendapatan.`)) return; const reason = window.prompt('Alasan menghanguskan:'); if (reason) void act(() => manage('POST', `/v1/reservations/${r.id}/settle`, { kind: 'FORFEIT', reason }), (d) => `Uang muka ${rp((d as { amount: number }).amount)} dihanguskan.`); }}>Hanguskan</button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}

      <section className="panel">
        <h2>{f.id === null ? 'Reservasi baru' : `Ubah reservasi #${f.id}`}</h2>
        <form className="form-grid" onSubmit={async (e) => {
          e.preventDefault();
          const r = f.id === null ? await act(() => manage('POST', `/v1/outlets/${outletId}/reservations`, body()), () => 'Reservasi dicatat.') : await act(() => manage('PUT', `/v1/reservations/${f.id}`, body()), () => 'Reservasi diperbarui.');
          if (r) setF(emptyForm());
        }}>
          <label>Nama tamu<input value={f.guestName} onChange={(e) => setF({ ...f, guestName: e.target.value })} maxLength={80} required /></label>
          <label>Telepon<input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" maxLength={24} placeholder="opsional" /></label>
          <label>Jumlah tamu<input type="number" min={1} max={50} value={f.partySize} onChange={(e) => setF({ ...f, partySize: e.target.value })} required /></label>
          <label>Tanggal<input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required /></label>
          <label>Jam<input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} required /></label>
          <label>Lama (menit)<input type="number" min={30} max={480} step={15} value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: e.target.value })} required /></label>
          <label>Meja
            <select value={f.tableNo} onChange={(e) => setF({ ...f, tableNo: e.target.value })}>
              <option value="">Belum ditentukan</option>
              {list.tables.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label>Catatan<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={200} placeholder="opsional" /></label>
          <div className="form-actions">
            <button type="submit" disabled={busy}>{f.id === null ? 'Simpan reservasi' : 'Simpan perubahan'}</button>
            {f.id !== null && <button type="button" className="secondary" onClick={() => setF(emptyForm())}>Batal ubah</button>}
          </div>
        </form>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Meja yang sama tidak bisa dipesan dua kali pada jam yang bertumpuk. Uang muka dicatat di sini lalu dipakai kasir lewat metode bayar &quot;Uang muka&quot;; sisanya harus dikembalikan atau dihanguskan
          oleh orang lain (atau owner), kalau tidak menjadi temuan di Insiden setelah 24 jam. Pemakaian uang muka yang tidak cocok dengan catatan ini juga menjadi temuan.
        </p>
      </section>
    </>
  );
}
