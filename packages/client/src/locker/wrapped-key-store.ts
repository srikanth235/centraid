/*
 * WHERE THE WRAPPED KEY SITS (#996, ruling R13).
 *
 * IndexedDB, not `localStorage`. Not because IndexedDB is a boundary — it is
 * not, and neither is `localStorage` — but because `apps/web/src/web-state.ts`
 * already keeps the connection record and its secret in plain `localStorage`,
 * and putting a wrapped vault key in the same bag would invite the next
 * reader to conclude that is where key material belongs. The wrapped blob is
 * useless without the passphrase either way; the separation is about what the
 * code teaches.
 *
 * The Electron seat uses the SAME `LockerSession` over a different store —
 * `safeStorage`-backed main-process storage — because `safeStorage` is
 * at-rest custody with no prompt (R13 names this exactly), which makes it a
 * fine place for the WRAPPED blob and a wrong place for `K`. One session
 * type, two stores, one boundary.
 */

import type { WrappedVaultKey, WrappedVaultKeyStore } from "./locker-unlock.js";

const DB_NAME = "centraid-locker";
const DB_VERSION = 1;
const STORE = "wrapped-keys";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE))
        db.createObjectStore(STORE, { keyPath: "vaultId" });
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("indexedDB open failed"))
    );
  });
}

function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () =>
          reject(request.error ?? new Error("indexedDB request failed"))
        );
        tx.addEventListener("complete", () => db.close());
      })
  );
}

/** The PWA's store. One row per vault, keyed by vault id. */
export function indexedDbWrappedKeyStore(): WrappedVaultKeyStore {
  return {
    async read(vaultId) {
      const row = await run<WrappedVaultKey | undefined>("readonly", (store) =>
        store.get(vaultId)
      );
      return row ?? null;
    },
    async write(wrapped) {
      await run("readwrite", (store) => store.put(wrapped));
    },
    async clear(vaultId) {
      await run("readwrite", (store) => store.delete(vaultId));
    },
  };
}

/**
 * The desktop's store, over whatever the main process exposes. A bridge, not
 * an implementation: the renderer must never hold a handle to `safeStorage`
 * itself, and the shape below is the whole contract the preload has to honour.
 */
export interface DesktopKeyBridge {
  readLockerKey: (vaultId: string) => Promise<string | null>;
  writeLockerKey: (vaultId: string, blob: string) => Promise<void>;
  clearLockerKey: (vaultId: string) => Promise<void>;
}

export function desktopWrappedKeyStore(
  bridge: DesktopKeyBridge
): WrappedVaultKeyStore {
  return {
    async read(vaultId) {
      const blob = await bridge.readLockerKey(vaultId);
      return blob === null ? null : (JSON.parse(blob) as WrappedVaultKey);
    },
    async write(wrapped) {
      await bridge.writeLockerKey(wrapped.vaultId, JSON.stringify(wrapped));
    },
    async clear(vaultId) {
      await bridge.clearLockerKey(vaultId);
    },
  };
}

/** An in-memory store — the shape a test drives, and nothing ships on it. */
export function memoryWrappedKeyStore(): WrappedVaultKeyStore {
  const rows = new Map<string, WrappedVaultKey>();
  return {
    read: async (vaultId) => rows.get(vaultId) ?? null,
    write: async (wrapped) => {
      rows.set(wrapped.vaultId, wrapped);
    },
    clear: async (vaultId) => {
      rows.delete(vaultId);
    },
  };
}
