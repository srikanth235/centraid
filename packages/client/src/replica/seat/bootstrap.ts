// FILE BOOTSTRAP (#996, ruling R4; wave 2).
//
// A seat does not replay itself into existence: it DOWNLOADS THE GATEWAY'S
// FILE. That single decision is what makes the rest of the seat small — no
// shape catalog, no per-entity walk, no window to negotiate — and it puts one
// hard problem in its place: a ~9 MB compressed artifact (~64 MB expanded at
// year-3 volume) arriving over a phone's connection, which will be
// interrupted.
//
// SO THE DOWNLOAD IS RESUMABLE, AND THE RESUME IS BY BYTE RANGE. The door
// serves a static file with a strong ETag that is a pure function of the log
// position it stands at, so "the same artifact" is a checkable claim rather
// than a hope: a resume asks for `bytes=N-` and pins the ETag, and an artifact
// that moved underneath restarts at zero rather than splicing two files into
// one that gunzips to garbage.
//
// AND IT CHECKS FOR ROOM FOR BOTH FILES FIRST. A re-bootstrap holds the seat's
// CURRENT file, the staged compressed artifact and the expanded new one at the
// same time. Discovering that halfway through means a phone with a corrupt
// seat and no space to fix it — the one failure a local-first app must not
// have — so the arithmetic is done before the first byte, against the
// platform's own estimate, and refused by name when it does not fit.

import type { SeatSnapshotHead } from "@centraid/core/protocol";

import { openSeatFile } from "./driver.js";
import type { SeatSqliteDriver } from "./driver.js";
import { SeatBootstrapNoRoomError } from "./seat-bootstrap-no-room-error.js";
import { SeatDriftError } from "./seat-drift-error.js";
import { SeatSnapshotMovedError } from "./seat-snapshot-moved-error.js";
import { initSeatState } from "./state.js";

/**
 * How much bigger the artifact gets when it is gunzipped, for the room check.
 *
 * MEASURED, NOT ROUNDED UP FROM NOTHING: the year-3 snapshot is ~64 MB of
 * SQLite that gzip-6 takes to ~9 MB, a ratio of 7.1. 8 is that with a margin,
 * because the check has to be wrong in the SAFE direction — refusing a
 * bootstrap that would have fitted costs a retry on wifi, and admitting one
 * that does not costs the seat.
 */
export const SEAT_SNAPSHOT_EXPANSION = 8;

/** What the gateway's snapshot door offers, as a seat sees it. */
export interface SeatSnapshotTransport {
  /** ETag, size and the three numbers, without downloading a byte. */
  head: () => Promise<SeatSnapshotHead>;
  /**
   * Bytes from `start` to the end of the artifact.
   *
   * `etag` is a REQUIREMENT, not a hint: the implementation sends it as
   * `If-Range` (or checks the response's own) and throws
   * {@link SeatSnapshotMovedError} when the artifact behind the door has
   * moved on — which is the only thing that makes a resume safe.
   */
  range: (start: number, etag: string) => AsyncIterable<Uint8Array>;
}

/**
 * Where the partly-downloaded artifact lives while it is arriving, and what
 * turns it into the seat's database file.
 *
 * Per platform: OPFS on the web, the app's own directory on device, `node:fs`
 * in the suites. The seam is here rather than inside the bootstrap so the
 * resume logic — the part that is actually subtle — is tested once against a
 * real filesystem instead of three times against three mocks.
 */
export interface SeatBootstrapStaging {
  /**
   * How many bytes of THIS artifact are already staged. Zero when nothing
   * usable is present — including when what is present belongs to a different
   * ETag, which is a discard, never a resume.
   */
  resumeAt: (etag: string) => Promise<number>;
  append: (etag: string, chunk: Uint8Array) => Promise<void>;
  /**
   * Gunzip the staged artifact into place as the seat's database file, and
   * drop the staging. Atomic from a reader's point of view: a caller that
   * arrives mid-install sees the old file or the new one.
   *
   * `prepare` RUNS ON THE INCOMING FILE, BEFORE THE SWAP (#1014, C17). The
   * bootstrap's `seat_state` used to be written after the move, so a kill in
   * that window left the gateway's file in place under this seat's name with
   * no `seat_state` in it — `seatStatePresent()` false, "this seat has no
   * copy", and the whole artifact downloaded again. Handing the write to the
   * host that owns the move makes install-and-name-it one step: the file that
   * appears is already this seat's, or no file appears at all. A host that
   * throws out of `prepare` must leave the destination UNTOUCHED — that is
   * what makes a mis-addressed artifact (C16) a refusal rather than a
   * replacement.
   *
   * A host with no window between "expanded" and "in place" (the browser's
   * SAH pool imports wholesale) simply does not call `prepare`; the bootstrap
   * notices and falls back to writing on the installed file.
   */
  install: (
    etag: string,
    prepare?: (driver: SeatSqliteDriver) => void
  ) => Promise<void>;
  discard: () => Promise<void>;
  /** Free bytes where these files live, or undefined when the host cannot say. */
  freeBytes: () => Promise<number | undefined>;
  /** Size of the seat file currently in place; 0 when there is none. */
  currentBytes: () => Promise<number>;
}

export interface SeatBootstrapProgress {
  readonly received: number;
  readonly total: number;
  readonly resumed: boolean;
}

/**
 * How the artifact's vault identity was established (#1014, C16).
 *
 * `"none"` is the honest answer against a gateway older than #1014 whose
 * snapshot carries no `core_vault` row it could be read from either — not a
 * failure, but not a check that happened, and the caller says so rather than
 * the bootstrap pretending.
 */
export type SeatVaultCheck = "door" | "file" | "both" | "none";

export interface SeatBootstrapResult {
  readonly seq: number;
  readonly epoch: string;
  readonly schemaEpoch: number;
  readonly vaultId: string;
  /** Compressed bytes the artifact took. */
  readonly bytes: number;
  /** Where the download picked up; 0 when it started fresh. */
  readonly resumedFrom: number;
  /** FTS shadow tables re-derived after the copy. */
  readonly ftsRebuilt: readonly string[];
  /** Which of the two vault-identity checks actually ran (#1014, C16). */
  readonly vaultChecked: SeatVaultCheck;
  readonly elapsedMs: number;
}

export interface SeatBootstrapOptions {
  readonly transport: SeatSnapshotTransport;
  readonly staging: SeatBootstrapStaging;
  readonly vaultId: string;
  /** Opens the INSTALLED file. Called once, after the artifact is in place. */
  readonly open: () => SeatSqliteDriver | Promise<SeatSqliteDriver>;
  readonly expansion?: number;
  readonly onProgress?: (progress: SeatBootstrapProgress) => void;
  /**
   * RELEASE THE SEAT'S CURRENT FILE — called once, after the last byte has
   * arrived and before the install touches the destination (#1014, V4/lane H).
   *
   * The caller used to close its handle before the download, because a file
   * cannot be replaced underneath an open SQLite connection. But the DOWNLOAD
   * does not touch the destination: only `install` does. Closing early meant
   * the seat had no open file for the whole of a multi-minute download on a
   * phone, so every read, every `state()` and — worst — every `outbox()` call
   * in that window threw `SeatWorkerNotOpenError`, which is a queued write the
   * member cannot reach. A bootstrap refused before the first byte (no room,
   * a mis-addressed artifact) never closed the file at all.
   *
   * So the window is now exactly the install. A caller that throws out of this
   * hook aborts the bootstrap with its own file still open.
   */
  readonly beforeInstall?: () => void | Promise<void>;
  readonly now?: () => number;
}

/**
 * The room check, as its own function so a caller can ask BEFORE it offers
 * the member a bootstrap — "not enough space" is a thing to say up front, not
 * a thing to discover at 80%.
 */
export function seatBootstrapRoomRequired(
  compressedBytes: number,
  currentBytes: number,
  expansion: number = SEAT_SNAPSHOT_EXPANSION
): number {
  return compressedBytes + compressedBytes * expansion + currentBytes;
}

/**
 * Download, install and open a seat file.
 *
 * Resumes an interrupted download of the SAME artifact and starts over on a
 * different one. Returns the position the file stands at — the number the
 * applier tails from.
 */
export async function bootstrapSeatFile(
  options: SeatBootstrapOptions
): Promise<SeatBootstrapResult> {
  const clock = options.now ?? ((): number => Date.now());
  const started = clock();
  const head = await options.transport.head();
  // THE FIRST OF THE TWO CHECKS, AND IT COSTS NOTHING (#1014, C16). The head
  // is read before a byte of the artifact moves, so a door answering for
  // another vault is refused before the download, before the staging and —
  // above all — before the destination is touched. R25's phone downloaded
  // 135 KB every ~6 s and installed it over another vault's seat; this is the
  // check that was missing.
  if (head.vaultId !== undefined && head.vaultId !== options.vaultId) {
    throw new SeatDriftError(
      "wrong-vault",
      `seat snapshot: artifact is for vault ${head.vaultId}, ` +
        `this seat is ${options.vaultId}`
    );
  }
  const free = await options.staging.freeBytes();
  const current = await options.staging.currentBytes();
  const required = seatBootstrapRoomRequired(
    head.bytes,
    current,
    options.expansion ?? SEAT_SNAPSHOT_EXPANSION
  );
  // `undefined` is "the host will not say", which is not the same as "there is
  // no room": refusing on an absent estimate would make the seat unusable in
  // every browser that has not shipped `navigator.storage.estimate`.
  if (free !== undefined && required > free) {
    throw new SeatBootstrapNoRoomError(required, free);
  }

  const resumedFrom = await options.staging.resumeAt(head.etag);
  let received = resumedFrom;
  options.onProgress?.({
    received,
    total: head.bytes,
    resumed: resumedFrom > 0,
  });
  if (received < head.bytes) {
    for await (const chunk of options.transport.range(received, head.etag)) {
      await options.staging.append(head.etag, chunk);
      received += chunk.byteLength;
      options.onProgress?.({
        received,
        total: head.bytes,
        resumed: resumedFrom > 0,
      });
    }
  }
  if (received !== head.bytes) {
    // A short artifact is not something to install and find out about later:
    // gzip will happily decompress a prefix and SQLite will happily open the
    // truncated file that comes out.
    await options.staging.discard();
    throw new SeatSnapshotMovedError(head.etag, undefined);
  }

  // THE HANDLE GOES DOWN HERE, NOT AT THE TOP (see `beforeInstall`). Every
  // byte is in; what follows is the only part that touches the destination.
  await options.beforeInstall?.();

  // ONE STEP, NOT TWO (#1014, C17). `name` is everything that turns the
  // gateway's file into THIS seat's file, and the host runs it on the incoming
  // copy so the move is the only observable transition. `named` records
  // whether it ran: a host with no pre-swap window falls through to the old
  // order below, which is worse but is still correct on a clean run.
  let ftsRebuilt: readonly string[] = [];
  let named = false;
  let fileVault: string | undefined;
  const name = (driver: SeatSqliteDriver): void => {
    openSeatFile(driver);
    // THE SECOND CHECK, AND THE ONE THAT NEEDS NO COOPERATION (#1014, C16).
    // The artifact carries the vault's own identity row, so the file can be
    // asked whose it is even when the door would not say — and it is asked
    // HERE, on the incoming copy, so a refusal leaves the seat's existing
    // file exactly where it was (C17's `prepare` contract).
    fileVault = snapshotVaultId(driver);
    if (fileVault !== undefined && fileVault !== options.vaultId) {
      throw new SeatDriftError(
        "wrong-vault",
        `seat snapshot: file is for vault ${fileVault}, ` +
          `this seat is ${options.vaultId}`
      );
    }
    ftsRebuilt = rebuildSeatFtsIndexes(driver);
    initSeatState(driver, {
      vaultId: options.vaultId,
      epoch: head.epoch,
      schemaEpoch: head.schemaEpoch,
      appliedSeq: head.seq,
      gatewayWatermark: head.seq,
    });
    named = true;
  };
  await options.staging.install(head.etag, name);
  const driver = await options.open();
  openSeatFile(driver);
  if (!named) name(driver);
  const checkedAtDoor = head.vaultId !== undefined;
  const checkedInFile = fileVault !== undefined;
  return {
    seq: head.seq,
    epoch: head.epoch,
    schemaEpoch: head.schemaEpoch,
    vaultId: options.vaultId,
    bytes: head.bytes,
    resumedFrom,
    ftsRebuilt,
    vaultChecked:
      checkedAtDoor && checkedInFile
        ? "both"
        : checkedAtDoor
          ? "door"
          : checkedInFile
            ? "file"
            : "none",
    elapsedMs: clock() - started,
  };
}

/**
 * Whose vault this file is, read off the file itself.
 *
 * `core_vault` is the vault's own identity row and it REPLICATES — it is not
 * on the private list, so every snapshot carries it. Reading it needs nothing
 * from the gateway, which is the point: it is the check that still works
 * against a door that will not name the vault, and the one a mis-addressed
 * artifact cannot talk its way past.
 *
 * `undefined` when the file has no such row — an empty baseline, or a schema
 * older than the one that introduced it. That is "cannot tell", never "it
 * matches": the caller reports it as an unverified bootstrap.
 */
function snapshotVaultId(driver: SeatSqliteDriver): string | undefined {
  const present = driver.all<{ name: string }>(
    `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'core_vault'`
  );
  if (present.length === 0) return undefined;
  const row = driver.all<{ vault_id: string }>(
    `SELECT vault_id FROM core_vault LIMIT 1`
  )[0];
  return row?.vault_id;
}

/**
 * Every FTS5 index in the file, re-derived after the copy.
 *
 * WHY IT IS NEEDED AT ALL, given the shadow tables arrive with the file: the
 * snapshot pipeline drops most of the schema out from under them (every
 * trigger but FTS sync, every index and view that names a private table) and
 * then VACUUMs, and the seat is the first process to WRITE to this file. A
 * rebuild is the one cheap statement that turns "the index came along with
 * everything else" into "the index answers for the rows this file has" — and
 * if it cannot, the seat finds out here rather than on the member's first
 * search.
 *
 * Found from `sqlite_schema`, never from a registry: the seat has no entity
 * registry, and the file's own answer is the one that matters.
 */
export function rebuildSeatFtsIndexes(
  driver: SeatSqliteDriver
): readonly string[] {
  const tables = driver
    .all<{ name: string }>(
      `SELECT name FROM sqlite_schema
        WHERE type = 'table' AND sql LIKE '%USING fts5%'
        ORDER BY name`
    )
    .map((row) => row.name);
  const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;
  for (const table of tables) {
    driver.run(
      `INSERT INTO ${quoted(table)}(${quoted(table)}) VALUES ('rebuild')`
    );
  }
  return tables;
}
