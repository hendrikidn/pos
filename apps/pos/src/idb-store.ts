import type { KeyValueStore } from '@pos/pos-core';

/** Penyimpanan lokal POS di IndexedDB. Bertahan saat tab ditutup atau perangkat mati. */
export class IdbStore implements KeyValueStore {
  private constructor(private readonly db: IDBDatabase) {}

  static open(name = 'pos-guard'): Promise<IdbStore> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(new IdbStore(req.result));
      req.onerror = () => reject(req.error);
    });
  }

  private tx(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction('kv', mode).objectStore('kv');
  }

  get<T>(key: string): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const r = this.tx('readonly').get(key);
      r.onsuccess = () => resolve(r.result as T | undefined);
      r.onerror = () => reject(r.error);
    });
  }

  write(set: Record<string, unknown>, remove: string[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction('kv', 'readwrite');
      const s = t.objectStore('kv');
      for (const [k, v] of Object.entries(set)) s.put(v, k);
      for (const k of remove) s.delete(k);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  keys(prefix: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const r = this.tx('readonly').getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`));
      r.onsuccess = () => resolve((r.result as string[]).sort());
      r.onerror = () => reject(r.error);
    });
  }
}
