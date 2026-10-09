import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PosEvent } from '@pos/events';
import type { Incident } from '@pos/rules';
import { AdminService } from '../src/admin.service';
import { createApp } from '../src/bootstrap';
import { Database } from '../src/db/database';
import pg from 'pg';
import { PgDriver, PgliteDriver, type Driver } from '../src/db/driver';
import type { MailMessage, Mailer } from '../src/mailer';
import type { Channel } from '../src/notification.service';
import type { Notifier } from '../src/pipeline.service';

export class RecordingNotifier implements Notifier {
  readonly critical: { tenantId: string; incident: Incident }[] = [];
  async notifyCritical(tenantId: string, incident: Incident) {
    this.critical.push({ tenantId, incident });
  }
}

/** Mailer uji: menyimpan email yang "terkirim" dan mengambil kode 6 digit dari isinya. */
export class RecordingMailer implements Mailer {
  readonly name = 'recording';
  readonly sent: MailMessage[] = [];
  failNext = false;
  async send(m: MailMessage) {
    if (this.failNext) { this.failNext = false; throw new Error('SMTP mati (simulasi)'); }
    this.sent.push(m);
  }
  /** Kode di email terakhir ke alamat itu. */
  lastCode(to: string): string | undefined {
    const m = [...this.sent].reverse().find((x) => x.to === to);
    return m?.text.match(/\b(\d{6})\b/)?.[1];
  }
  count(to: string) { return this.sent.filter((x) => x.to === to).length; }
}

/**
 * Driver basis data uji. Bawaan: PGlite (PostgreSQL WASM) di memori. Bila `TEST_PG_URL` diisi (mis. postgres://user:pw@127.0.0.1:5433/postgres),
 * setiap harness memakai DATABASE BARU di server PostgreSQL asli itu dan menghapusnya saat selesai, sehingga seluruh suite bisa dijalankan
 * terhadap PostgreSQL sungguhan: `TEST_PG_URL=... npx vitest run`.
 */
async function createDriver(): Promise<{ driver: Driver; cleanup: () => Promise<void> }> {
  const base = process.env['TEST_PG_URL'];
  if (!base) return { driver: await PgliteDriver.create(), cleanup: async () => undefined };
  const name = `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  const driver = new PgDriver(url.toString(), 3);
  return {
    driver,
    cleanup: async () => {
      const c = new pg.Client({ connectionString: base });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}

export interface Harness {
  db: Database;
  mailer: RecordingMailer;
  app: NestExpressApplication;
  admin: AdminService;
  notifier: RecordingNotifier;
  setNow(ms: number): void;
  /** Panggilan HTTP sungguhan ke server Nest. */
  http(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: any }>;
  /** GET apa adanya (tanpa mengurai JSON): untuk unduhan seperti CSV. */
  raw(path: string, token?: string): Promise<{ status: number; headers: Headers; text: string }>;
  postEvents(token: string, events: PosEvent[]): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

export class RecordingChannel implements Channel {
  readonly name = 'fake';
  readonly sent: { to: string; text: string }[] = [];
  failFor = new Set<string>();
  async send(m: { to: string; text: string }) {
    if (this.failFor.has(m.to)) throw new Error('gagal kirim (simulasi)');
    this.sent.push(m);
  }
}

/** Dengan `channel`, NotificationService sungguhan dipakai; tanpa itu, notifikasi hanya dicatat oleh RecordingNotifier. */
export async function createHarness(nowMs: number, opts: { channel?: Channel; pinIterations?: number; trustProxy?: number | string; mailer?: RecordingMailer; evaluateMode?: 'sync' | 'background'; evaluateMinGapMs?: number; alertSink?: (text: string) => Promise<void> } = {}): Promise<Harness> {
  const { driver, cleanup } = await createDriver();
  const db = new Database(driver);
  await db.migrate();
  const notifier = new RecordingNotifier();
  const mailer = opts.mailer ?? new RecordingMailer();
  let now = nowMs;
  const app = await createApp(db, { notifier: opts.channel ? undefined : notifier, channel: opts.channel, dashboardUrl: 'https://guard.example', pinIterations: opts.pinIterations ?? 1_000, clock: () => now, trustProxy: opts.trustProxy, mailer, evaluateMode: opts.evaluateMode, evaluateMinGapMs: opts.evaluateMinGapMs, alertSink: opts.alertSink });
  await app.listen(0);
  const port = (app.getHttpServer().address() as { port: number }).port;
  const admin = app.get(AdminService);

  const http: Harness['http'] = async (method, path, token, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  return {
    db, app, admin, notifier, mailer,
    setNow: (ms) => { now = ms; },
    http,
    raw: async (path, token) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      // ignoreBOM: pertahankan BOM di awal teks (res.text() membuangnya) supaya tes bisa memeriksanya.
      return { status: res.status, headers: res.headers, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer()) };
    },
    postEvents: (token, events) => http('POST', '/v1/events', token, { events }),
    close: async () => {
      await app.close();
      await db.close();
      await cleanup();
    },
  };
}
