import { EventChain, type EventBody, type PosEvent } from '@pos/events';
import type { Signer } from './signer';
import type { KeyValueStore } from './store';

const pad = (seq: number) => String(seq).padStart(10, '0');

export interface RecorderConfig {
  deviceId: string;
  outletId: string;
  store: KeyValueStore;
  now: () => number;
  /** Bila ada, setiap event ditandatangani dengan kunci perangkat. */
  signer?: Signer;
}

/**
 * Mencatat event ke rantai hash perangkat dan menyimpannya ke outbox lokal.
 * Posisi rantai dan event ditulis dalam satu operasi, sehingga aplikasi yang mati di tengah jalan
 * tidak meninggalkan nomor urut yang hilang atau ganda.
 */
export class Recorder {
  private chain!: EventChain;
  private clockOffsetMs = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly cfg: RecorderConfig) {}

  async init(): Promise<void> {
    const position = await this.cfg.store.get<{ seq: number; prevHash: string }>('chain');
    this.chain = new EventChain(this.cfg.deviceId, this.cfg.outletId, position);
    this.clockOffsetMs = (await this.cfg.store.get<number>('clockOffsetMs')) ?? 0;
  }

  get offsetMs(): number {
    return this.clockOffsetMs;
  }

  /** Penyimpanan kecil untuk status klien (mis. kunci yang sudah didaftarkan). */
  getMeta<T>(key: string): Promise<T | undefined> {
    return this.cfg.store.get<T>(`meta:${key}`);
  }

  setMeta(key: string, value: unknown): Promise<void> {
    return this.cfg.store.write({ [`meta:${key}`]: value });
  }

  get signer(): Signer | undefined {
    return this.cfg.signer;
  }

  async setClockOffset(ms: number): Promise<void> {
    this.clockOffsetMs = ms;
    await this.cfg.store.write({ clockOffsetMs: ms });
  }

  /** Antrean serial: pencatatan bersamaan tidak boleh menimpa posisi rantai satu sama lain. */
  record(body: EventBody, actorId: string | null = null): Promise<PosEvent> {
    const run = async () => {
      const before = this.chain.position;
      const event = this.chain.append({
        ...body,
        deviceTime: this.cfg.now(),
        actorId,
        clockOffsetMs: this.clockOffsetMs,
      });
      if (this.cfg.signer) {
        try {
          event.sig = await this.cfg.signer.sign(event.hash);
        } catch (e) {
          // Tanpa tanda tangan event tidak boleh disimpan; kembalikan rantai agar tidak ada nomor urut yang hilang.
          this.chain = new EventChain(this.cfg.deviceId, this.cfg.outletId, before);
          throw e;
        }
      }
      await this.cfg.store.write({ [`outbox:${pad(event.seq)}`]: event, chain: this.chain.position });
      return event;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async pending(limit = 500): Promise<PosEvent[]> {
    const keys = (await this.cfg.store.keys('outbox:')).slice(0, limit);
    const events = await Promise.all(keys.map((k) => this.cfg.store.get<PosEvent>(k)));
    return events.filter((e): e is PosEvent => e !== undefined);
  }

  async pendingCount(): Promise<number> {
    return (await this.cfg.store.keys('outbox:')).length;
  }

  /** Menghapus event yang sudah diterima server (seq ≤ ackedSeq). */
  async ack(ackedSeq: number): Promise<void> {
    const keys = (await this.cfg.store.keys('outbox:')).filter((k) => Number(k.slice(7)) <= ackedSeq);
    if (keys.length > 0) await this.cfg.store.write({}, keys);
  }
}
