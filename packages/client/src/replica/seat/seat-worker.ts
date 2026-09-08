// THE BROWSER SEAT'S WORKER (#996, wave 2).
//
// The host half of `SeatWorkerCore`: sqlite-wasm over the OPFS SAH pool, an
// OPFS staging directory, and the snapshot door over `fetch`. Everything that
// decides anything lives in the core; this file only says which platform it
// is on.
//
// WHY A SECOND WORKER RATHER THAN OPS ON THE OLD ONE. The two stores hold
// DIFFERENT FILES — the old store's `replica_row` projection and the seat's
// copy of `vault.db` — and a member running behind the flag has both on disk
// during wave 2. One worker owning both would need a mode switch on every op
// and a shared VFS pool between two schemas; two workers is the smaller thing,
// and wave 5 deletes one of them outright.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { SAHPoolUtil } from "@sqlite.org/sqlite-wasm";

import { httpSeatSnapshotTransport } from "./http-snapshot-transport.js";
import { opfsSeatStaging } from "./opfs-staging.js";
import type { OpfsDirectory } from "./opfs-staging.js";
import { WasmSeatDriver } from "./wasm-seat-driver.js";
import { SeatWorkerCore } from "./worker-core.js";
import type { SeatWorkerHost } from "./worker-core.js";
import { serializeSeatError } from "./worker-protocol.js";
import type {
  SeatWorkerOpenOptions,
  SeatWorkerRequest,
  SeatWorkerResponse,
} from "./worker-protocol.js";

interface WorkerScope {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<SeatWorkerRequest>) => void
  ) => void;
  postMessage: (message: SeatWorkerResponse) => void;
  close: () => void;
}

const scope = globalThis as unknown as WorkerScope;
const post = scope.postMessage.bind(scope);

let pool: SAHPoolUtil | undefined;

/**
 * The pool, opened once per worker.
 *
 * Its directory is namespaced by the vault, exactly as the old worker's is:
 * two vaults open in two tabs must not share a pool, or the second one's
 * bootstrap replaces the first one's file.
 */
async function poolFor(options: SeatWorkerOpenOptions): Promise<SAHPoolUtil> {
  if (pool) return pool;
  const sqlite3 = await sqlite3InitModule();
  pool = await sqlite3.installOpfsSAHPoolVfs({
    directory: `/.centraid-seat-${fileStem(options.dbName)}`,
    initialCapacity: 4,
  });
  await pool.reserveMinimumCapacity(4);
  return pool;
}

function fileStem(name: string): string {
  const stem = /centraid-seat-(?<stem>[a-f0-9]+)\.sqlite3$/u.exec(name)?.groups
    ?.stem;
  if (!stem) throw new Error("seat database name is not namespaced");
  return stem;
}

async function stagingDirectory(
  options: SeatWorkerOpenOptions
): Promise<OpfsDirectory> {
  const root = await navigator.storage.getDirectory();
  return (await root.getDirectoryHandle(
    `.centraid-seat-staging-${fileStem(options.dbName)}`,
    { create: true }
  )) as unknown as OpfsDirectory;
}

let open: SeatWorkerOpenOptions | undefined;

const host: SeatWorkerHost = {
  openDatabase: async (options) => {
    open = options;
    const held = await poolFor(options);
    return new WasmSeatDriver(new held.OpfsSAHPoolDb(options.dbName));
  },
  staging: async (options) => {
    if (!open) throw new Error("seat worker has not been opened");
    return opfsSeatStaging({
      directory: await stagingDirectory(open),
      pool: await poolFor(open),
      dbName: open.dbName,
      ...(options.expansion === undefined ? {} : {}),
    });
  },
  // THE FILE, GONE (#996, R9 and the revocation path). A closed seat still has
  // the vault on disk; a revoked device must not. `unlink` removes it from the
  // SAH pool, and `wipeFiles` clears whatever a half-finished bootstrap left
  // staged in the same pool.
  destroyDatabase: async (options) => {
    const held = await poolFor(options);
    try {
      held.unlink(options.dbName);
    } catch {
      // A pool that never held this name has nothing to unlink.
    }
  },
  transport: (options) =>
    httpSeatSnapshotTransport({
      url: options.snapshotUrl,
      ...(options.headers ? { headers: options.headers } : {}),
    }),
};

const core = new SeatWorkerCore(host, {
  // UNSOLICITED, BOTH OF THEM. A page can land while nobody is awaiting a
  // reply, and a bootstrap's progress is only useful while it is still
  // happening.
  onChange: (notice) => post({ event: "change", notice }),
  onBootstrapProgress: (progress) =>
    post({ event: "bootstrap-progress", progress }),
});

scope.addEventListener("message", (event) => {
  void core.dispatch(event.data).then(
    (result) => {
      post({ id: event.data.id, ok: true, result });
      if (event.data.op === "close") scope.close();
    },
    (error: unknown) => {
      post({ id: event.data.id, ok: false, error: serializeSeatError(error) });
    }
  );
});
