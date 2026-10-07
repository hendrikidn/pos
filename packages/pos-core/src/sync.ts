import type { Recorder } from './recorder';

export interface SyncConfig {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  now: () => number;
}

export type SyncResult =
  | { ok: true; sent: number; remaining: number; issues: { seq: number; kind: string; detail: string }[] }
  | { ok: false; reason: 'offline' | 'unauthorized' | 'rejected' | 'server' | 'enrollment'; message: string };

/** Selisih jam di bawah ini dianggap derau (latensi jaringan), bukan jam yang bergeser. */
const OFFSET_NOISE_MS = 2_000;

/**
 * Mengirim outbox ke server secara berurutan. Aman dipanggil berulang: server idempoten per (perangkat, seq),
 * dan event baru dihapus dari outbox hanya setelah server mengakui nomor urutnya.
 */
export class SyncClient {
  private running = false;

  constructor(
    private readonly recorder: Recorder,
    private readonly cfg: SyncConfig,
  ) {}

  /**
   * Mendaftarkan kunci publik perangkat ke server sebelum mengirim event. Setelah terdaftar, server menuntut
   * tanda tangan pada setiap event, sehingga event bertanda tangan yang tertunda di antrean tetap sah.
   */
  private async ensureEnrolled(fetchImpl: typeof fetch): Promise<SyncResult | null> {
    const signer = this.recorder.signer;
    if (!signer) return null;
    const publicKey = await signer.publicKey();
    if ((await this.recorder.getMeta<string>('enrolledKey')) === publicKey) return null;
    let res: Response;
    try {
      res = await fetchImpl(`${this.cfg.baseUrl}/v1/device/key`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ publicKey }),
      });
    } catch (e) {
      return { ok: false, reason: 'offline', message: e instanceof Error ? e.message : 'tidak dapat terhubung' };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized', message: 'token perangkat ditolak' };
    if (res.status === 409) return { ok: false, reason: 'enrollment', message: 'server sudah memiliki kunci lain untuk perangkat ini; minta owner mengatur ulang kunci' };
    if (!res.ok) return { ok: false, reason: 'enrollment', message: `pendaftaran kunci gagal (${res.status})` };
    await this.recorder.setMeta('enrolledKey', publicKey);
    return null;
  }

  async flush(): Promise<SyncResult> {
    if (this.running) return { ok: true, sent: 0, remaining: await this.recorder.pendingCount(), issues: [] };
    this.running = true;
    try {
      const fetchImpl = this.cfg.fetchImpl ?? fetch;
      const enrolled = await this.ensureEnrolled(fetchImpl);
      if (enrolled) return enrolled;
      let sent = 0;
      const issues: { seq: number; kind: string; detail: string }[] = [];

      for (;;) {
        const batch = await this.recorder.pending(500);
        if (batch.length === 0) break;

        let res: Response;
        try {
          res = await fetchImpl(`${this.cfg.baseUrl}/v1/events`, {
            method: 'POST',
            headers: { authorization: `Bearer ${this.cfg.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ events: batch }),
          });
        } catch (e) {
          return { ok: false, reason: 'offline', message: e instanceof Error ? e.message : 'tidak dapat terhubung' };
        }
        if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized', message: 'token perangkat ditolak' };
        if (res.status === 400) return { ok: false, reason: 'rejected', message: (await res.text()).slice(0, 300) };
        if (!res.ok) return { ok: false, reason: 'server', message: `server menjawab ${res.status}` };

        const body = (await res.json()) as {
          ackedSeq: number; accepted: number; duplicates: number; serverTime: number;
          issues: { seq: number; kind: string; detail: string }[];
        };
        await this.recorder.ack(body.ackedSeq);
        sent += batch.length;
        issues.push(...body.issues);

        const offset = this.cfg.now() - body.serverTime;
        await this.recorder.setClockOffset(Math.abs(offset) > OFFSET_NOISE_MS ? offset : 0);
      }
      return { ok: true, sent, remaining: await this.recorder.pendingCount(), issues };
    } finally {
      this.running = false;
    }
  }
}
