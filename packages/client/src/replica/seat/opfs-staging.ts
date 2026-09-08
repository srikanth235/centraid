// STAGING IN THE BROWSER (#996, R4, R15).
//
// The web seat's half of `SeatBootstrapStaging`. Two OPFS surfaces are in play
// and they are not the same one, which is the whole subtlety here:
//
//   - THE PART FILE lives in ordinary OPFS, written through a sync access
//     handle. It is bytes arriving over the network and nothing reads it as a
//     database, so it wants the plain file API and nothing else.
//   - THE DATABASE lives in the SAH POOL VFS, which is not a directory a
//     caller can write a file into — it is a pool of pre-allocated handles
//     with the file name kept in a header. So "install" is `importDb`, which
//     is the pool's own way of taking a whole database, and there is no
//     rename to do because the pool does the swap.
//
// AND THE ESTIMATE IS THE BROWSER'S, NOT A GUESS. `navigator.storage.estimate`
// is what OQ-2's probe reads; a browser that will not answer gets `undefined`
// and the bootstrap proceeds, because refusing on a missing estimate would
// make the seat unusable where it is merely unmeasurable.

import type { SAHPoolUtil } from "@sqlite.org/sqlite-wasm";

import type { SeatBootstrapStaging } from "./bootstrap.js";

/** The subset of OPFS this module uses, so the suites can stand it up. */
export interface OpfsDirectory {
  getFileHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<OpfsFileHandle>;
  removeEntry: (
    name: string,
    options?: { recursive?: boolean }
  ) => Promise<void>;
}

export interface OpfsFileHandle {
  getFile: () => Promise<{
    size: number;
    arrayBuffer: () => Promise<ArrayBuffer>;
  }>;
  createWritable: (options?: {
    keepExistingData?: boolean;
  }) => Promise<OpfsWritable>;
}

export interface OpfsWritable {
  write: (data: {
    type: "write";
    position: number;
    data: Uint8Array;
  }) => Promise<void>;
  close: () => Promise<void>;
}

export interface OpfsSeatStagingOptions {
  /** Where the part file and its marker live. */
  readonly directory: OpfsDirectory;
  /** The SAH pool holding the seat's database. */
  readonly pool: SAHPoolUtil;
  /** The database's name inside the pool, absolute and vault-namespaced. */
  readonly dbName: string;
  /** `navigator.storage.estimate`, injected so a suite can answer for it. */
  readonly estimate?: () => Promise<{ quota?: number; usage?: number }>;
  /** Gunzip. The browser's own, through `DecompressionStream`, by default. */
  readonly gunzip?: (bytes: Uint8Array) => Promise<Uint8Array>;
}

const PART = "seat-snapshot.part";
const MARKER = "seat-snapshot.etag";

async function readText(
  directory: OpfsDirectory,
  name: string
): Promise<string | undefined> {
  try {
    const handle = await directory.getFileHandle(name);
    const file = await handle.getFile();
    return new TextDecoder().decode(await file.arrayBuffer());
  } catch {
    return undefined;
  }
}

async function sizeOf(directory: OpfsDirectory, name: string): Promise<number> {
  try {
    return (await (await directory.getFileHandle(name)).getFile()).size;
  } catch {
    return 0;
  }
}

/**
 * `DecompressionStream("gzip")` — the browser's own, so the seat carries no
 * inflate implementation of its own into the bundle.
 */
async function browserGunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function opfsSeatStaging(
  options: OpfsSeatStagingOptions
): SeatBootstrapStaging {
  const gunzip = options.gunzip ?? browserGunzip;
  const discard = async (): Promise<void> => {
    await options.directory.removeEntry(PART).catch(() => undefined);
    await options.directory.removeEntry(MARKER).catch(() => undefined);
  };
  return {
    resumeAt: async (etag: string): Promise<number> => {
      const held = await readText(options.directory, MARKER);
      if (held !== etag) {
        await discard();
        return 0;
      }
      return sizeOf(options.directory, PART);
    },
    append: async (etag: string, chunk: Uint8Array): Promise<void> => {
      const marker = await options.directory.getFileHandle(MARKER, {
        create: true,
      });
      const markerWriter = await marker.createWritable();
      await markerWriter.write({
        type: "write",
        position: 0,
        data: new TextEncoder().encode(etag),
      });
      await markerWriter.close();
      const part = await options.directory.getFileHandle(PART, {
        create: true,
      });
      // `keepExistingData` plus an explicit position is the append: a writable
      // opened without it TRUNCATES, which on a resumed download is the whole
      // prefix thrown away silently.
      const at = await sizeOf(options.directory, PART);
      const writer = await part.createWritable({ keepExistingData: true });
      await writer.write({ type: "write", position: at, data: chunk });
      await writer.close();
    },
    install: async (): Promise<void> => {
      const staged = await (
        await options.directory.getFileHandle(PART)
      ).getFile();
      const expanded = await gunzip(new Uint8Array(await staged.arrayBuffer()));
      // `importDb` REPLACES the pool's file wholesale, which is the atomic
      // swap this seam promises — there is no half-imported state a reader
      // can observe, and no rename to get wrong.
      await options.pool.importDb(options.dbName, expanded);
      await discard();
    },
    discard,
    freeBytes: async (): Promise<number | undefined> => {
      const estimate =
        options.estimate ??
        (globalThis.navigator?.storage?.estimate.bind(
          globalThis.navigator.storage
        ) as (() => Promise<{ quota?: number; usage?: number }>) | undefined);
      if (!estimate) return undefined;
      try {
        const answer = await estimate();
        if (typeof answer.quota !== "number") return undefined;
        return Math.max(0, answer.quota - (answer.usage ?? 0));
      } catch {
        return undefined;
      }
    },
    /**
     * ZERO, DELIBERATELY, AND NOT BECAUSE IT IS UNKNOWN.
     *
     * The room check counts the file being replaced so a re-bootstrap does not
     * run out of space mid-swap. In a browser that file is ALREADY inside
     * `estimate().usage` — the quota is the origin's, and the seat's database
     * is part of what it has spent — so counting it again would subtract it
     * twice and refuse bootstraps that fit. The node staging, which measures a
     * filesystem's free space rather than an origin's quota, counts it for
     * real.
     */
    currentBytes: (): Promise<number> => Promise.resolve(0),
  };
}
