// THE PHONE'S SEAT STAGING (#996, wave 4b).
//
// Wave 2's `nodeSeatStaging` in `node:fs` terms, in expo-file-system's: append
// to a part file, keep the ETag beside it, expand into place, move in.
//
// THREE THINGS THIS HOST HAS TO SAY FOR ITSELF, and they are the reason it is
// not the node one with different imports:
//
//   - THE EXPANSION IS JS (`gunzip`). Hermes has no zlib and the artifact is a
//     gzip BODY on purpose (the door's ranges depend on it), so the seat does
//     the decompressing. It is the one place a phone holds the compressed and
//     expanded artifact in memory at once; the alternative is a streaming
//     inflate whose window would have to be reconstructed after a kill, and a
//     bootstrap that has to be right is worth the peak.
//   - THE MOVE IS `moveSync` ONTO THE DATABASE PATH, and the WAL and shm of the
//     file being REPLACED are deleted with it. Leaving them has SQLite recover
//     a dead journal over a file whose pages it describes nothing of.
//   - FREE SPACE IS `Paths.availableDiskSpace`, which the room check compares
//     against ~9 MB + ~64 MB + the current seat. A phone that cannot answer is
//     told to say nothing rather than to guess (the check treats `undefined` as
//     "the host will not say", never as "there is room").

import { Directory, File, FileMode, Paths } from "expo-file-system";

import type { SeatBootstrapStaging } from "@centraid/client/replica/native";
import { gunzip } from "@centraid/client/replica/seat/gunzip";

import { pathToFileUri } from "../../../modules/centraid-storage";

export interface ExpoSeatStagingOptions {
  /** Directory for the part file and its ETag marker; created on demand. */
  readonly directory: string;
  /** The seat's database file — what `install` moves into place. */
  readonly databasePath: string;
}

function fileAt(...parts: string[]): File {
  return new File(pathToFileUri(parts.join("/")));
}

function sizeOf(file: File): number {
  try {
    return file.exists ? (file.size ?? 0) : 0;
  } catch {
    return 0;
  }
}

function removeQuietly(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // A file the OS already removed is the outcome asked for.
  }
}

export function expoSeatStaging(
  options: ExpoSeatStagingOptions
): SeatBootstrapStaging {
  const part = (): File => fileAt(options.directory, "snapshot.part");
  const marker = (): File => fileAt(options.directory, "snapshot.etag");
  const ensureDirectory = (): void => {
    const dir = new Directory(pathToFileUri(options.directory));
    if (!dir.exists) dir.create({ intermediates: true });
  };
  const discard = (): Promise<void> => {
    removeQuietly(part());
    removeQuietly(marker());
    return Promise.resolve();
  };
  return {
    resumeAt: (etag: string): Promise<number> => {
      ensureDirectory();
      const held = marker();
      const stored = held.exists ? held.textSync() : undefined;
      // A marker that does not match is a DISCARD, never a resume: splicing
      // two artifacts is how a seat gets a file that expands and is corrupt.
      if (stored !== etag) return discard().then(() => 0);
      return Promise.resolve(sizeOf(part()));
    },
    append: (etag: string, chunk: Uint8Array): Promise<void> => {
      ensureDirectory();
      const held = marker();
      // Written with the FIRST chunk, not before it: a marker with no bytes
      // behind it answers a later `resumeAt` with 0 anyway.
      held.write(etag);
      const target = part();
      if (!target.exists) target.create();
      const handle = target.open(FileMode.Append);
      try {
        handle.writeBytes(chunk);
      } finally {
        handle.close();
      }
      return Promise.resolve();
    },
    install: (): Promise<void> => {
      const staged = part().bytesSync();
      const incoming = fileAt(`${options.databasePath}.incoming`);
      removeQuietly(incoming);
      incoming.create({ intermediates: true });
      incoming.write(gunzip(staged));
      const destination = fileAt(options.databasePath);
      removeQuietly(destination);
      incoming.moveSync(destination);
      removeQuietly(fileAt(`${options.databasePath}-wal`));
      removeQuietly(fileAt(`${options.databasePath}-shm`));
      return discard();
    },
    discard,
    freeBytes: (): Promise<number | undefined> => {
      try {
        const free = Paths.availableDiskSpace;
        return Promise.resolve(Number.isFinite(free) ? free : undefined);
      } catch {
        return Promise.resolve(undefined);
      }
    },
    currentBytes: (): Promise<number> =>
      Promise.resolve(sizeOf(fileAt(options.databasePath))),
  };
}
