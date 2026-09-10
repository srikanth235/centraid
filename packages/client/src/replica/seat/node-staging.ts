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
import type { SeatCarryOverSidecar } from "./carry-over.js";
import type { SeatSqliteDriver } from "./driver.js";
import { NodeSeatDriver } from "./node-seat-driver.js";

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
    install: async (
      _etag: string,
      prepare?: (driver: SeatSqliteDriver) => void
    ): Promise<void> => {
      const staged = await readFile(part);
      const incoming = `${options.databasePath}.incoming`;
      await mkdir(path.dirname(options.databasePath), { recursive: true });
      await writeFile(incoming, gunzipSync(staged));
      // BEFORE THE RENAME, NOT AFTER (#1014, C17). The seat's own tables are
      // written onto the incoming file while it is still nameless, so the
      // rename below publishes a file that is already this seat's — and a
      // `prepare` that REFUSES (a mis-addressed artifact, C16) leaves the
      // destination exactly as it was, with only the scratch file to remove.
      if (prepare) {
        const driver = new NodeSeatDriver(incoming);
        try {
          prepare(driver);
        } catch (error) {
          driver.close();
          await rm(incoming, { force: true });
          await rm(`${incoming}-wal`, { force: true });
          await rm(`${incoming}-shm`, { force: true });
          throw error;
        }
        driver.close();
        // WAL and shm of the INCOMING file: `prepare` opened it in WAL mode,
        // and a rename that left them behind would carry one file's journal
        // over another's pages.
        await rm(`${incoming}-wal`, { force: true });
        await rm(`${incoming}-shm`, { force: true });
      }
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

/**
 * The carry-over sidecar on a real filesystem (#1014, C5/T6).
 *
 * Beside the seat file rather than in the staging directory, because the two
 * have different lifetimes: staging is discarded the moment an install lands,
 * and the stash must outlive exactly that. Written through a scratch file and
 * renamed, so a kill mid-write leaves the previous stash or none — never half
 * a queue that parses into a shorter one.
 */
export function nodeSeatCarryOverSidecar(
  databasePath: string
): SeatCarryOverSidecar {
  const file = `${databasePath}.carry-over.json`;
  return {
    read: () => readFile(file, "utf8").catch(() => undefined),
    write: async (payload: string): Promise<void> => {
      const scratch = `${file}.writing`;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(scratch, payload, "utf8");
      await rename(scratch, file);
    },
    clear: async (): Promise<void> => {
      await rm(file, { force: true });
      await rm(`${file}.writing`, { force: true });
    },
  };
}
