// STAGING ON A REAL FILESYSTEM (#996, wave 2).
//
// The desktop seat's staging, and the one the suites run the resume against.
// It is deliberately the boring implementation: append to a part file, keep
// the ETag beside it, gunzip into place, rename.
//
// THE ETAG MARKER IS THE WHOLE RESUME. A part file on its own says "some
// bytes of something"; a part file with the artifact's ETag beside it says
// "the first N bytes of exactly this artifact", and only the second is safe to
// continue. A marker that does not match is a DISCARD, never a resume — which
// is what makes "the snapshot moved while the phone was asleep" a slow
// bootstrap rather than a corrupt one.
//
// AND THE INSTALL IS A RENAME. Gunzip beside the destination and rename in, so
// a process that dies mid-install leaves the seat's existing file intact and
// the next attempt starts from the staged artifact it already has.

import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import type { SeatBootstrapStaging } from "./bootstrap.js";

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

export interface NodeSeatStagingOptions {
  /** Where the part file and its marker live. Created on demand. */
  readonly directory: string;
  /** The seat's database file — what `install` renames into place. */
  readonly databasePath: string;
}

export function nodeSeatStaging(
  options: NodeSeatStagingOptions
): SeatBootstrapStaging {
  const part = path.join(options.directory, "snapshot.part");
  const marker = path.join(options.directory, "snapshot.etag");
  const discard = async (): Promise<void> => {
    await rm(part, { force: true });
    await rm(marker, { force: true });
  };
  return {
    resumeAt: async (etag: string): Promise<number> => {
      await mkdir(options.directory, { recursive: true });
      const held = await readFile(marker, "utf8").catch(() => undefined);
      if (held !== etag) {
        await discard();
        return 0;
      }
      return sizeOf(part);
    },
    append: async (etag: string, chunk: Uint8Array): Promise<void> => {
      await mkdir(options.directory, { recursive: true });
      // The marker is written with the FIRST chunk, not before it: a marker
      // that exists with no bytes behind it would answer a later `resumeAt`
      // with 0 anyway, and writing it first is one more state to reason about.
      await writeFile(marker, etag, "utf8");
      await appendFile(part, chunk);
    },
    install: async (): Promise<void> => {
      const staged = await readFile(part);
      const incoming = `${options.databasePath}.incoming`;
      await mkdir(path.dirname(options.databasePath), { recursive: true });
      await writeFile(incoming, gunzipSync(staged));
      await rename(incoming, options.databasePath);
      // The WAL and shm of the file being REPLACED describe pages that no
      // longer exist; leaving them would have SQLite recover a dead journal
      // over the new file.
      await rm(`${options.databasePath}-wal`, { force: true });
      await rm(`${options.databasePath}-shm`, { force: true });
      await discard();
    },
    discard,
    freeBytes: async (): Promise<number | undefined> => {
      try {
        const fs = await statfs(options.directory);
        return Number(fs.bavail) * Number(fs.bsize);
      } catch {
        return undefined;
      }
    },
    currentBytes: (): Promise<number> => sizeOf(options.databasePath),
  };
}
