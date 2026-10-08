import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { lineKey, lineLabel, type OrderRecord, type StaffPublic } from '@pos/pos-core';
import { ApprovalDialog, Modal, PinPad } from './dialogs';
import { CustomerDisplay, DISPLAY_CHANNEL, type DisplayView } from './CustomerDisplay';
import { Kds } from './Kds';
import { Logo } from './Logo';
import { OrderPanel } from './OrderPanel';
import { hardware, isNative, kioskWanted, loadPrinterSetting, savePrinterSetting, setKioskWanted, type PrinterKind } from './native';
import { createRuntime, saveSettings, setDemo, type Boot, type Runtime } from './runtime';
import { isActive, METHOD_LABEL, NEEDS_APPROVAL, orderLabel, rp, run, STATUS_LABEL, TYPE_LABEL, type Ctx } from './ui';

type Tab = 'order' | 'dapur' | 'shift' | 'pengaturan';

export function App() {
  if (new URLSearchParams(location.search).has('display')) return <CustomerDisplay />;
  return <Pos />;
}

function Pos() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const rt: Runtime | null = boot?.kind === 'ready' ? boot.runtime : null;
  const [, setTick] = useState(0);
  const [tab, setTab] = useState<Tab>('order');
  const [selected, setSelected] = useState<string | null>(null);
  const [toasts, setToasts] = useState<{ id: number; message: string; kind: 'error' | 'info' }[]>([]);
  const [approval, setApproval] = useState<{ need: number; message: string; exclude: string[]; resolve: (v: { userId: string; pin: string }[] | null) => void } | null>(null);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    void createRuntime().then(setBoot);
  }, []);
  useEffect(() => {
    if (!rt) return;
    const a = rt.onSyncChange(bump);
    const b = rt.sim?.subscribe(bump);
    return () => (a(), b?.());
  }, [rt, bump]);

  const toast = useCallback((message: string, kind: 'error' | 'info' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000);
  }, []);

  const ctx: Ctx | null = useMemo(
    () =>
      rt && {
        rt, bump, toast, selectOrder: setSelected,
        approve: (need, message, exclude = []) => new Promise((resolve) => setApproval({ need, message, exclude, resolve })),
      },
    [rt, bump, toast],
  );

  // Layar customer: kirim tagihan order aktif ke jendela kedua.
  const channel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    channel.current = new BroadcastChannel(DISPLAY_CHANNEL);
    return () => channel.current?.close();
  }, []);
  useEffect(() => {
    if (!rt) return;
    const send = () => {
      const v = rt.engine.customerView(selected);
      const view = v ? ({ ...v, paperClaim: rt.engine.paperClaimActive() } satisfies DisplayView) : null;
      channel.current?.postMessage(view);
      if (isNative) void hardware.displayShow({ view: JSON.stringify(view) }).catch(() => undefined);
    };
    send();
    const ch = channel.current;
    if (ch) ch.onmessage = (e) => e.data?.hello && send();
  });

  if (!boot) return <div className="boot">Memuat…</div>;
  if (boot.kind === 'kds') return <Kds runtime={boot.runtime} />;
  if (boot.kind === 'setup') return <Setup settings={boot.settings} error={boot.error} />;
  if (!rt || !ctx) return <div className="boot">Memuat…</div>;
  const { engine } = rt;
  const user = engine.currentUser();

  return (
    <div className="app">
      {!user ? <Login ctx={ctx} /> : (
        <>
          <Header ctx={ctx} user={user} tab={tab} setTab={setTab} />
          <ConfigBanner ctx={ctx} />
          <main>
            {tab === 'order' && <Orders ctx={ctx} selected={selected} />}
            {tab === 'dapur' && <Kitchen ctx={ctx} />}
            {tab === 'shift' && <Shift ctx={ctx} />}
            {tab === 'pengaturan' && <Settings ctx={ctx} />}
          </main>
        </>
      )}
      {approval && user && (
        <ApprovalDialog
          need={approval.need} message={approval.message} staff={engine.staff()} currentUser={user.id} exclude={approval.exclude}
          onDone={(v) => { approval.resolve(v); setApproval(null); }}
        />
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.message}</div>)}
      </div>
    </div>
  );
}

function Login({ ctx }: { ctx: Ctx }) {
  const { engine, config } = ctx.rt;
  const [who, setWho] = useState<StaffPublic | null>(null);
  const [pin, setPin] = useState('');
  useEffect(() => {
    if (!who || pin.length < 4) return;
    void engine.login(who.id, pin).then((r) => {
      if (r.ok) ctx.bump();
      else {
        ctx.toast(r.message, 'error');
        setPin('');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);
  return (
    <div className="login">
      <Logo size={56} />
      <h1>{config.merchantName}</h1>
      <p className="muted">Pilih nama, lalu masukkan PIN.</p>
      <div className="login-body">
        <div className="staff">
          {engine.staff().map((s) => (
            <button key={s.id} className={who?.id === s.id ? 'on' : ''} onClick={() => { setWho(s); setPin(''); }}>
              <span className="avatar" aria-hidden="true">{(s.name.trim()[0] ?? '?').toUpperCase()}</span>
              {s.name}
            </button>
          ))}
        </div>
        {who ? <PinPad value={pin} onChange={setPin} max={4} /> : <p className="muted pin-hint">Pilih nama untuk memasukkan PIN.</p>}
      </div>
      {config.demoPins && <p className="muted small">Mode demo — PIN: {Object.entries(config.demoPins).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>}
    </div>
  );
}

function Header({ ctx, user, tab, setTab }: { ctx: Ctx; user: StaffPublic; tab: Tab; setTab: (t: Tab) => void }) {
  const { engine, config } = ctx.rt;
  const s = ctx.rt.syncStatus();
  const shift = engine.currentShift();
  const claim = engine.paperClaimActive();
  return (
    <header className="topbar">
      <div className="brand"><Logo size={32} />{config.merchantName}</div>
      <nav className="tabs">
        {(['order', 'dapur', 'shift', 'pengaturan'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'order' ? 'Order' : t === 'dapur' ? 'Dapur' : t === 'shift' ? 'Shift' : 'Pengaturan'}</button>
        ))}
      </nav>
      <div className="status">
        <span className={`dot ${!s.configured ? 'gray' : s.online ? 'green' : 'red'}`} />
        <span className="muted small">
          {!s.configured ? 'Belum terhubung' : s.online ? (s.pending ? `${s.pending} tertunda` : 'Tersinkron') : `Offline · ${s.pending} tertunda`}
        </span>
        <button className={`secondary ${claim ? 'warn' : ''}`} onClick={() => void run(ctx, () => engine.setPaperClaim(!claim))}>
          {claim ? 'Kertas habis ✓' : 'Kertas habis'}
        </button>
        <span className="muted small">{shift ? 'Shift buka' : 'Shift tutup'} · {user.name}</span>
        <button className="ghost" onClick={() => { engine.logout(); ctx.selectOrder(null); ctx.bump(); }}>Keluar</button>
      </div>
    </header>
  );
}

function Orders({ ctx, selected }: { ctx: Ctx; selected: string | null }) {
  const { engine } = ctx.rt;
  const [asking, setAsking] = useState<'table' | 'employee' | null>(null);
  const [table, setTable] = useState('');
  const shift = engine.currentShift();
  const orders = engine.listOrders().filter((o) => o.shiftId === shift?.id);
  const current = selected ? engine.getOrder(selected) : undefined;

  const create = async (type: 'DINE_IN' | 'TAKE_AWAY' | 'EMPLOYEE', opts: { tableNo?: string; employeeId?: string } = {}) => {
    let r = await engine.createOrder(type, opts);
    // Makan karyawan di luar kuota (atau untuk diri sendiri) perlu supervisor yang bukan pembuat dan bukan penerima.
    if (!r.ok && NEEDS_APPROVAL.has(r.code)) {
      setAsking(null);
      const approvers = await ctx.approve(1, r.message, opts.employeeId ? [opts.employeeId] : []);
      if (!approvers) return ctx.bump();
      r = await engine.createOrder(type, { ...opts, approver: approvers[0] });
    }
    if (!r.ok) ctx.toast(r.message, 'error');
    ctx.bump();
    if (r.ok) ctx.selectOrder(r.value.id);
    setAsking(null);
    setTable('');
  };

  if (!shift) return <OpenShift ctx={ctx} />;
  return (
    <div className="pos-orders">
      <div className="order-strip">
        <div className="strip-new">
          <button onClick={() => void create('TAKE_AWAY')}>+ Take-away</button>
          <button className="secondary" onClick={() => setAsking('table')}>+ Dine-in</button>
          <button className="secondary" onClick={() => setAsking('employee')}>+ Karyawan</button>
        </div>
        <ul className="strip-list" aria-label="Order di shift ini">
          {orders.length === 0 && <li className="strip-empty">Belum ada order di shift ini.</li>}
          {orders.filter((o) => o.state.status !== 'MERGED').map((o) => (
            <li key={o.id}>
              <button className={`order-card ${selected === o.id ? 'on' : ''}`} onClick={() => ctx.selectOrder(o.id)}>
                <span><b>#{o.number}</b> {orderLabel(o, engine.staff())}</span>
                <span className={`pill s-${o.state.status}`}>{STATUS_LABEL[o.state.status]}</span>
                <span className="amt">{rp(engine.totals(o).total)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {current ? (
        <OrderPanel key={current.id} ctx={ctx} order={current} />
      ) : (
        <section className="empty-orders">
          <h2>Siap menerima order</h2>
          <p>Pilih order di atas, atau buat yang baru: Take-away, Dine-in, atau Karyawan.</p>
        </section>
      )}

      {asking === 'table' && (
        <Modal title="Nomor meja" onClose={() => setAsking(null)}>
          <PinPad value={table} onChange={setTable} max={3} />
          <div className="actions"><button disabled={!table} onClick={() => void create('DINE_IN', { tableNo: table })}>Buat order</button></div>
        </Modal>
      )}
      {asking === 'employee' && (
        <Modal title="Order karyawan" onClose={() => setAsking(null)}>
          <p className="muted">Pilih karyawan penerima. Order karyawan dipantau: makan kedua hari ini, atau untuk diri sendiri, memerlukan persetujuan supervisor.</p>
          <div className="reasons">
            {engine.staff().map((s) => (
              <button key={s.id} className="secondary" onClick={() => void create('EMPLOYEE', { employeeId: s.id })}>{s.name}</button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function OpenShift({ ctx }: { ctx: Ctx }) {
  const [cash, setCash] = useState('');
  return (
    <section className="panel center">
      <h2>Buka shift</h2>
      <p className="muted">Masukkan modal awal di laci kas.</p>
      <label className="field">Modal awal
        <input inputMode="numeric" value={cash} onChange={(e) => setCash(e.target.value.replace(/\D/g, ''))} placeholder="0" />
      </label>
      <button onClick={() => void run(ctx, () => ctx.rt.engine.openShift(Number(cash || 0)))}>Buka shift</button>
    </section>
  );
}

function Kitchen({ ctx }: { ctx: Ctx }) {
  const { engine } = ctx.rt;
  const queue = engine.listOrders().filter((o) => isActive(o) && o.state.status !== 'DRAFT' || (o.state.status === 'PAID' && o.kitchen !== 'SERVED' && o.items.some((l) => l.sentQty > 0))).reverse();
  return (
    <section className="kitchen">
      {queue.length === 0 && <div className="panel empty">Tidak ada pesanan di dapur.</div>}
      {queue.map((o: OrderRecord) => (
        <article key={o.id} className="panel ticket">
          <h3>#{o.number} {o.tableNo ? `· Meja ${o.tableNo}` : TYPE_LABEL[o.type]}</h3>
          <ul>
            {o.items.filter((l) => l.sentQty > 0).map((l) => (
              <li key={lineKey(l)}>{l.sentQty}× {lineLabel(l)}{l.note && <small className="line-note"> “{l.note}”</small>}</li>
            ))}
          </ul>
          <div className="actions wrap">
            {(['COOKING', 'READY', 'SERVED'] as const).map((s) => (
              <button key={s} className={o.kitchen === s ? '' : 'secondary'} onClick={() => void run(ctx, () => engine.setKitchenStatus(o.id, s))}>
                {s === 'COOKING' ? 'Dimasak' : s === 'READY' ? 'Siap' : 'Disajikan'}
              </button>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}

function Shift({ ctx }: { ctx: Ctx }) {
  const { engine } = ctx.rt;
  const shift = engine.currentShift();
  const [cash, setCash] = useState('');
  if (!shift) return <OpenShift ctx={ctx} />;
  const orders = engine.listOrders().filter((o) => o.shiftId === shift.id);
  const byMethod = new Map<string, number>();
  for (const p of orders.flatMap((o) => o.payments)) byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.amount);
  return (
    <section className="panel center">
      <h2>Shift berjalan</h2>
      <p className="muted">Dibuka {new Date(shift.openedAt).toLocaleTimeString('id-ID')} · modal {rp(shift.openingCash)} · {orders.length} order</p>
      <dl className="totals">
        {[...byMethod].map(([m, v]) => <div key={m}><dt>{METHOD_LABEL[m]}</dt><dd>{rp(v)}</dd></div>)}
      </dl>
      <h3>Tutup shift (hitungan buta)</h3>
      <p className="muted">Hitung uang di laci, lalu masukkan jumlahnya. Angka yang diharapkan sistem tidak ditampilkan.</p>
      <label className="field">Uang di laci
        <input inputMode="numeric" value={cash} onChange={(e) => setCash(e.target.value.replace(/\D/g, ''))} />
      </label>
      <button disabled={cash === ''} onClick={async () => { const r = await run(ctx, () => engine.closeShift(Number(cash))); if (r.ok) { ctx.toast('Shift ditutup. Ingat menutup batch EDC dan memotret slip settlement.', 'info'); setCash(''); } }}>Tutup shift</button>
      <p className="notice">Setelah menutup shift: lakukan <b>settlement EDC</b> dan simpan slipnya. Slip dipakai untuk mencocokkan pembayaran non-tunai.</p>
    </section>
  );
}

function Settings({ ctx }: { ctx: Ctx }) {
  const { rt } = ctx;
  const [apiUrl, setApiUrl] = useState(rt.settings.apiUrl);
  const [token, setToken] = useState(rt.settings.token);
  const s = rt.syncStatus();
  return (
    <section className="split">
      <div className="panel">
        <h2>Koneksi ke server</h2>
        <label className="field">Alamat API<input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} /></label>
        <label className="field">Token perangkat<input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="dev_…" /></label>
        <div className="actions">
          <button onClick={() => { saveSettings({ apiUrl, token }); location.reload(); }}>Simpan dan muat ulang</button>
        </div>
        <p className="muted small">
          {s.configured ? (s.online ? 'Terhubung.' : `Tidak terhubung${s.lastError ? `: ${s.lastError}` : ''}.`) : 'Belum diisi. Event tetap tersimpan di perangkat dan dikirim saat terhubung.'}
          {' '}Event tertunda: {s.pending}.
        </p>
        <h2>Konfigurasi</h2>
        <p className="muted small">
          {(() => {
            const c = rt.configStatus();
            return c.mode === 'demo' ? 'Mode demo (data contoh).' : `Dari server · versi ${c.version ?? '—'} · diperbarui ${c.fetchedAt ? new Date(c.fetchedAt).toLocaleString('id-ID') : '—'}${c.lastError ? ` · ${c.lastError}` : ''}`;
          })()}
        </p>
        <div className="actions wrap"><button className="secondary" onClick={() => void rt.refreshConfig()}>Muat ulang konfigurasi</button></div>
        <PrinterSettings rt={rt} ctx={ctx} />
        <p><a href="?display=1" target="_blank" rel="noreferrer">Buka layar customer (jendela baru)</a></p>
      </div>
      <div className="panel">
        <h2>Struk tercetak</h2>
        {!rt.sim && <p className="muted">Printer sungguhan dipakai; struk keluar dari printer.</p>}
        {rt.sim && rt.sim.tray.length === 0 && <p className="muted">Belum ada.</p>}
        {rt.sim?.tray.map((t, i) => <pre key={i} className="paper">{t}</pre>)}
      </div>
    </section>
  );
}

function ConfigBanner({ ctx }: { ctx: Ctx }) {
  const c = ctx.rt.configStatus();
  if (c.mode === 'demo') return <div className="banner warn">Mode demo: data dan PIN contoh, bukan dari server.</div>;
  if (!c.stale && !c.lastError) return null;
  const hours = c.fetchedAt ? Math.floor((Date.now() - c.fetchedAt) / 3_600_000) : null;
  return (
    <div className="banner warn">
      {c.lastError ? `Konfigurasi tidak dapat diperbarui (${c.lastError}). ` : ''}
      {hours !== null ? `Konfigurasi terakhir diperbarui ${hours} jam lalu. ` : ''}
      Staf yang baru dinonaktifkan mungkin masih bisa masuk sampai perangkat tersambung kembali.
    </div>
  );
}

function Setup({ settings, error }: { settings: ReturnType<typeof import('./runtime').loadSettings>; error: string | null }) {
  const [apiUrl, setApiUrl] = useState(settings.apiUrl);
  const [token, setToken] = useState(settings.token);
  return (
    <div className="login">
      <Logo size={56} />
      <h1>Hubungkan terminal</h1>
      <p className="muted">Terminal ini belum punya konfigurasi. Masukkan alamat server dan token perangkat dari administrator. Staf, PIN, menu, dan pajak diunduh dari server.</p>
      <div className="panel" style={{ textAlign: 'left' }}>
        <label className="field">Alamat API<input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} /></label>
        <label className="field">Token perangkat<input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="dev_…" /></label>
        {error && <p className="notice">Gagal mengambil konfigurasi: {error}</p>}
        <div className="actions">
          <button disabled={!token.trim()} onClick={() => { setDemo(false); saveSettings({ apiUrl, token: token.trim() }); location.reload(); }}>Hubungkan</button>
        </div>
      </div>
      <p className="muted small">
        Hanya untuk mencoba tanpa server:{' '}
        <button className="ghost" onClick={() => { setDemo(true); location.reload(); }}>gunakan data demo</button>
      </p>
    </div>
  );
}

function PrinterSettings({ rt, ctx }: { rt: Runtime; ctx: Ctx }) {
  const [setting, setSetting] = useState(loadPrinterSetting());
  const [kiosk, setKiosk] = useState(kioskWanted());
  const user = rt.engine.currentUser();
  const key = rt.keyInfo();
  const posture = rt.posture();
  return (
    <>
      <h2>Printer</h2>
      <div className="seg">
        {(['sim', 'lan', 'usb'] as PrinterKind[]).map((k) => (
          <button key={k} className={setting.kind === k ? 'on' : ''} disabled={k !== 'sim' && !isNative} onClick={() => setSetting({ ...setting, kind: k })}>
            {k === 'sim' ? 'Simulasi' : k === 'lan' ? 'Jaringan' : 'USB'}
          </button>
        ))}
      </div>
      {!isNative && <p className="muted small">Printer sungguhan hanya tersedia di aplikasi Android.</p>}
      {setting.kind === 'lan' && (
        <div className="edc-row" style={{ gridTemplateColumns: '2fr 1fr' }}>
          <input aria-label="Alamat printer" placeholder="192.168.1.50" value={setting.host} onChange={(e) => setSetting({ ...setting, host: e.target.value.trim() })} />
          <input aria-label="Port" inputMode="numeric" value={String(setting.port)} onChange={(e) => setSetting({ ...setting, port: Number(e.target.value.replace(/\D/g, '')) || 9100 })} />
        </div>
      )}
      <div className="actions wrap">
        <button onClick={() => { savePrinterSetting(setting); location.reload(); }}>Simpan dan muat ulang</button>
        {rt.escpos && (
          <>
            <button className="secondary" onClick={async () => ctx.toast((await rt.printer.print('Anatta POS\nTes cetak OK')) ? 'Tes cetak terkirim' : 'Tes cetak gagal', 'info')}>Tes cetak</button>
            <button className="secondary" onClick={async () => ctx.toast((await rt.escpos!.openDrawer()) ? 'Laci dibuka' : 'Gagal membuka laci', 'info')}>Buka laci</button>
          </>
        )}
      </div>
      {rt.sim ? (
        <>
          <label className="check"><input type="checkbox" checked={rt.sim.paper} onChange={(e) => rt.sim!.setPaper(e.target.checked)} /> Kertas tersedia (simulasi)</label>
          <p className="muted small">Matikan untuk mensimulasikan kertas habis. Status printer dicatat sebagai event.</p>
        </>
      ) : (
        <p className="muted small">
          Status kertas: {rt.printerState() ?? 'printer tidak melaporkan status (R5 memakai tombol "Kertas habis")'}
        </p>
      )}
      {isNative && (
        <>
          <h2>Perangkat</h2>
          <label className="check">
            <input
              type="checkbox"
              checked={kiosk}
              disabled={!user || user.role === 'CASHIER'}
              onChange={async (e) => {
                const on = e.target.checked;
                try {
                  if (on) await hardware.enterKiosk(); else await hardware.exitKiosk();
                  setKioskWanted(on);
                  setKiosk(on);
                } catch (err) {
                  ctx.toast(err instanceof Error ? err.message : 'Gagal mengubah mode kios', 'error');
                }
              }}
            />{' '}
            Mode kios (hanya supervisor ke atas yang bisa mengubah)
          </label>
          <p className="muted small">
            Kunci perangkat: {key.hardwareBacked === null ? '—' : key.hardwareBacked ? 'Android Keystore, berbasis perangkat keras' : 'Android Keystore, perangkat lunak'}.
            {posture && <> Waktu otomatis: {posture.autoTime ? 'ya' : 'TIDAK'} · USB debugging: {posture.adb ? 'AKTIF' : 'mati'} · Kios: {posture.kiosk ? 'ya' : 'tidak'}.</>}
          </p>
        </>
      )}
    </>
  );
}
