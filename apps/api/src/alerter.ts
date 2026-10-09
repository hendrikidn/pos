import { Injectable } from '@nestjs/common';

export type AlertSink = (text: string) => Promise<void>;

/** Sink dari environment: `ALERT_WEBHOOK_URL` menerima POST JSON `{ text, content }` (cocok untuk Slack, Discord, Mattermost, n8n). Kosong = tidak ada pengiriman. */
export function alertSinkFromEnv(): AlertSink | null {
  const url = process.env['ALERT_WEBHOOK_URL'];
  if (!url) return null;
  return async (text) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(8_000) });
    if (!r.ok) throw new Error(`webhook menjawab ${r.status}`);
  };
}

/**
 * Peringatan operasional (kesalahan server, evaluasi gagal, database tidak siap) ke webhook. Satu kunci hanya terkirim sekali per jendela
 * (bawaan 5 menit) supaya badai kesalahan tidak membanjiri saluran; kegagalan mengirim tidak pernah menggagalkan pemanggil.
 */
@Injectable()
export class Alerter {
  private readonly last = new Map<string, number>();
  sink: AlertSink | null = alertSinkFromEnv();
  readonly sent: string[] = [];

  constructor(private readonly windowMs = Number(process.env['ALERT_THROTTLE_MS'] ?? 5 * 60_000), private readonly now: () => number = Date.now) {}

  /** Mengembalikan true bila pesan dikirim (bukan diredam atau tanpa sink). */
  async alert(key: string, text: string): Promise<boolean> {
    const t = this.now();
    const prev = this.last.get(key);
    if (prev !== undefined && t - prev < this.windowMs) return false;
    this.last.set(key, t);
    if (this.last.size > 500) for (const [k, v] of this.last) if (t - v >= this.windowMs) this.last.delete(k);
    const body = `[Anatta POS] ${text}`;
    this.sent.push(body);
    if (this.sent.length > 50) this.sent.shift();
    if (!this.sink) return false;
    try {
      await this.sink(body);
      return true;
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', msg: 'peringatan gagal dikirim', error: e instanceof Error ? e.message : String(e) }));
      return false;
    }
  }
}
