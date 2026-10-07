import type { KeyValueStore } from '@pos/pos-core';

/** Penyimpanan lokal POS di IndexedDB. Bertahan saat tab ditutup atau perangkat mati. */
export class IdbStore implements KeyValueStore {
  private constructor(private readonly db: IDBDatabase) {}

  /**
   * Membuka penyimpanan. Nama sebelumnya `pos-guard`: saat pertama kali dibuka dengan nama baru, isinya disalin dari
   * database lama. Ini penting karena di dalamnya ada posisi rantai event (nomor urut dan hash terakhir), order, antrean
   * kirim, dan kunci tanda tangan: terminal yang mulai dari kosong akan memakai seq 1 lagi dan ditolak server sebagai
   * duplikat berbeda isi (R24).
   */
  static async open(name = 'anatta-pos'): Promise<IdbStore> {
    const store = new IdbStore(await IdbStore.openDb(name));
    if (name === 'anatta-pos') await store.importLegacy('pos-guard');
    return store;
  }

  private static openDb(name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** Menyalin semua isi database lama bila yang baru masih kosong, lalu menghapus yang lama. Gagal = diam, terminal tetap jalan. */
  private async importLegacy(legacy: string): Promise<void> {
    try {
      if (typeof indexedDB.databases !== 'function') return;
      if (!(await indexedDB.databases()).some((d) => d.name === legacy)) return;
      if ((await this.count()) > 0) return;
      const old = await IdbStore.openDb(legacy);
      const entries = await new Promise<[IDBValidKey, unknown][]>((resolve, reject) => {
        const out: [IDBValidKey, unknown][] = [];
        const cur = old.transaction('kv', 'readonly').objectStore('kv').openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) { out.push([c.key, c.value]); c.continue(); } else resolve(out);
        };
        cur.onerror = () => reject(cur.error);
      });
      old.close();
      if (entries.length > 0) {
        await new Promise<void>((resolve, reject) => {
          const t = this.db.transaction('kv', 'readwrite');
          for (const [k, v] of entries) t.objectStore('kv').put(v, k);
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        });
      }
      indexedDB.deleteDatabase(legacy);
    } catch {
      /* migrasi gagal: pakai penyimpanan baru yang kosong, database lama dibiarkan agar tidak ada data yang hilang */
    }
  }

  private count(): Promise<number> {
    return new Promise((resolve, reject) => {
      const r = this.tx('readonly').count();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
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
