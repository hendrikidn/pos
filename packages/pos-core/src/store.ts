/** Penyimpanan kunci-nilai lokal POS. Implementasi browser memakai IndexedDB; tes memakai MemoryStore. */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  /** Menulis dan menghapus beberapa kunci sekaligus (atomik pada implementasi yang mendukung transaksi). */
  write(set: Record<string, unknown>, remove?: string[]): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

export class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, string>();

  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.data.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async write(set: Record<string, unknown>, remove: string[] = []): Promise<void> {
    for (const [k, v] of Object.entries(set)) this.data.set(k, JSON.stringify(v));
    for (const k of remove) this.data.delete(k);
  }

  async keys(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
