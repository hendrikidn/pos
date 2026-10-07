import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PosEvent } from '@pos/events';
import type { Incident } from '@pos/rules';
import { AdminService } from '../src/admin.service';
import { createApp } from '../src/bootstrap';
import { Database } from '../src/db/database';
import { PgliteDriver } from '../src/db/driver';
import type { Channel } from '../src/notification.service';
import type { Notifier } from '../src/pipeline.service';

export class RecordingNotifier implements Notifier {
  readonly critical: { tenantId: string; incident: Incident }[] = [];
  async notifyCritical(tenantId: string, incident: Incident) {
    this.critical.push({ tenantId, incident });
  }
}

export interface Harness {
  db: Database;
  app: NestExpressApplication;
  admin: AdminService;
  notifier: RecordingNotifier;
  setNow(ms: number): void;
  /** Panggilan HTTP sungguhan ke server Nest. */
  http(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: any }>;
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
export async function createHarness(nowMs: number, opts: { channel?: Channel; pinIterations?: number; trustProxy?: number | string } = {}): Promise<Harness> {
  const db = new Database(await PgliteDriver.create());
  await db.migrate();
  const notifier = new RecordingNotifier();
  let now = nowMs;
  const app = await createApp(db, { notifier: opts.channel ? undefined : notifier, channel: opts.channel, dashboardUrl: 'https://guard.example', pinIterations: opts.pinIterations ?? 1_000, clock: () => now, trustProxy: opts.trustProxy });
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
    db, app, admin, notifier,
    setNow: (ms) => { now = ms; },
    http,
    postEvents: (token, events) => http('POST', '/v1/events', token, { events }),
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
