import sqlite3InitModule, { type Database, type SAHPoolUtil } from '@sqlite.org/sqlite-wasm';

import { ReplicaProtocolError } from './errors.js';
import { SqliteReplicaStore } from './sqlite-store.js';
import type {
  ReplicaWorkerRequest,
  ReplicaWorkerResponse,
  SerializedReplicaError,
} from './worker-protocol.js';
import type { ReplicaMode, ReplicaStatus, ReplicaWorkerOpenOptions } from './types.js';

interface WorkerScope {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<ReplicaWorkerRequest>) => void,
  ): void;
  postMessage(message: ReplicaWorkerResponse): void;
  close(): void;
}

const scope = globalThis as unknown as WorkerScope;
let store: SqliteReplicaStore | undefined;
let mode: ReplicaMode | undefined;
let pool: SAHPoolUtil | undefined;
let dbName: string | undefined;
let persistentOpened = false;
let purgeOnly = false;

scope.addEventListener('message', (event) => {
  void dispatch(event.data).then(
    (result) => {
      // eslint-disable-next-line unicorn/require-post-message-target-origin -- (#406) Worker.postMessage has no targetOrigin overload; governance: allow-no-unjustified-suppressions Web Worker API false positive
      scope.postMessage({ id: event.data.id, ok: true, result });
      if (event.data.op === 'close' || event.data.op === 'purge') scope.close();
    },
    (error: unknown) => {
      // eslint-disable-next-line unicorn/require-post-message-target-origin -- (#406) Worker.postMessage has no targetOrigin overload; governance: allow-no-unjustified-suppressions Web Worker API false positive
      scope.postMessage({ id: event.data.id, ok: false, error: serializeError(error) });
    },
  );
});

async function dispatch(request: ReplicaWorkerRequest): Promise<unknown> {
  switch (request.op) {
    case 'open':
      return open(request.payload);
    case 'status':
      return status();
    case 'catalog':
      return requiredStore().catalog();
    case 'bootstrap':
      return requiredStore().bootstrap(request.payload);
    case 'apply-changes':
      return requiredStore().applyChanges(request.payload);
    case 'read':
      return requiredStore().read(request.payload.request, request.payload.mutations);
    case 'search':
      return requiredStore().search(request.payload.request, request.payload.mutations);
    case 'wipe':
      requiredStore().wipe();
      return undefined;
    case 'close':
      closeDatabase();
      return undefined;
    case 'purge':
      await purgeDatabase();
      return undefined;
  }
}

async function open(options: ReplicaWorkerOpenOptions): Promise<ReplicaStatus> {
  if (store) throw new ReplicaProtocolError('Replica worker is already open');
  if (!options.dbName.startsWith('/')) {
    throw new ReplicaProtocolError('Persistent replica database name must be absolute');
  }
  if (options.purgeOnly && !options.remember) {
    throw new ReplicaProtocolError('A purge-only replica worker requires durable storage');
  }
  persistentOpened = false;
  purgeOnly = options.purgeOnly === true;
  const sqlite3 = await sqlite3InitModule();
  let db: Database | undefined;
  if (options.remember && opfsAvailable()) {
    try {
      const directory = `/.centraid-replica-${fileStem(options.dbName)}`;
      pool = await sqlite3.installOpfsSAHPoolVfs({ directory, initialCapacity: 4 });
      mode = 'opfs-sahpool';
      dbName = options.dbName;
      persistentOpened = true;
      if (purgeOnly) return status();
      await pool.reserveMinimumCapacity(4);
      db = new pool.OpfsSAHPoolDb(options.dbName);
    } catch (error) {
      // A normal open failure must not turn recovery into an implicit wipe.
      // Release handles while preserving the pool so a later purge/retry can
      // make the terminal decision explicitly.
      try {
        pool?.pauseVfs();
      } catch {
        /* A partially installed VFS has no safe cleanup action here. */
      }
      pool = undefined;
      db = undefined;
      mode = undefined;
      dbName = undefined;
      persistentOpened = false;
      if (purgeOnly) throw error;
    }
  }
  if (purgeOnly) {
    throw new ReplicaProtocolError('Persistent replica storage is unavailable for confirmed purge');
  }
  if (!db) {
    db = new sqlite3.oo1.DB(':memory:', 'c');
    mode = 'memory';
  }
  store = new SqliteReplicaStore(db, options.vaultId);
  return status();
}

function status(): ReplicaStatus {
  if (!mode) throw new ReplicaProtocolError('Replica mode was not initialized');
  if (purgeOnly) return { mode, cursor: null, schemaEpoch: null };
  const current = requiredStore().status();
  return { mode, cursor: current.cursor, schemaEpoch: current.schemaEpoch };
}

function requiredStore(): SqliteReplicaStore {
  if (!store) throw new ReplicaProtocolError('Replica worker has not been opened');
  return store;
}

function closeDatabase(): void {
  store?.close();
  store = undefined;
}

async function purgeDatabase(): Promise<void> {
  closeDatabase();
  if (persistentOpened) {
    if (!pool || !dbName) {
      throw new ReplicaProtocolError('Persistent replica purge could not be confirmed');
    }
    const names = pool.getFileNames();
    if (names.includes(dbName) && pool.unlink(dbName) !== true) {
      throw new ReplicaProtocolError(`Persistent replica database ${dbName} is still in use`);
    }
    if ((await pool.removeVfs()) !== true) {
      throw new ReplicaProtocolError('Persistent replica VFS removal could not be confirmed');
    }
  }
  pool = undefined;
  dbName = undefined;
  persistentOpened = false;
  purgeOnly = false;
}

function opfsAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage !== 'undefined' &&
    typeof navigator.storage.getDirectory === 'function'
  );
}

function fileStem(name: string): string {
  const match = /centraid-replica-([a-f0-9]+)\.sqlite3$/.exec(name);
  if (!match?.[1]) throw new ReplicaProtocolError('Replica database name is not namespaced');
  return match[1];
}

function serializeError(error: unknown): SerializedReplicaError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  const shaped = error as Error & { code?: string; reason?: string };
  return {
    name: error.name,
    message: error.message,
    ...(shaped.code ? { code: shaped.code } : {}),
    ...(shaped.reason ? { reason: shaped.reason } : {}),
  };
}
