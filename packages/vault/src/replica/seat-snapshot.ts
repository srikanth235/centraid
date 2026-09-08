// THE SANITISED SEAT SNAPSHOT (#996, ruling R4).
//
// Bootstrap is a FILE COPY, not a replay: a seat holds the gateway's schema
// and the gateway's rows, so the fastest and least error-prone way to hand it
// one is to give it the file. What makes that safe is not what the copy
// contains but what has been physically removed from it.
//
// THE PIPELINE, AND WHAT EACH STEP IS FOR (P4, variant B):
//
//   1. `VACUUM INTO` — a consistent copy taken without stopping writers.
//      Measured under 20 s of concurrent writes at ~2 ms each: 7,550 writes
//      committed, 0 errors, 2 blocked over 50 ms, worst latency 179 ms.
//   2. `PRAGMA secure_delete = ON` on the COPY, before anything is dropped.
//      Without it, a dropped table's bytes stay legible in the pages the drop
//      frees.
//   3. Drop every trigger except FTS sync, then every index and view that
//      names a private table, then the private tables themselves. A seat runs
//      no DDL generator and no triggers but FTS sync; a trigger that survives
//      would fire against a table the seat's writer does not have.
//   4. Truncate the log, LEAVING ITS CURSOR. The seat needs to know where the
//      copy sits in the gateway's sequence — that is the whole point of
//      bootstrapping from a file rather than from seq 0 — and it needs none of
//      the history behind it.
//   5. A final `VACUUM`, which is what actually reclaims the freed pages. P4's
//      control: skip it with `secure_delete` off and ten planted credential
//      canaries are still readable in 4,360 free pages while `sqlite_schema`
//      already reads clean. READING THE SCHEMA IS NOT THE TEST. The bytes are.
//
// WHY NOT ALSO DROP THE FTS SHADOW TABLES. It saves 12 MB on the golden vault
// and it is not free: the 57 retained FTS sync triggers survive the drop and
// then fail on the seat's first write with `no such table: main.fts_…`. That
// trade is a separate decision with a seat-side rebuild step attached; it is
// not part of this pipeline.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { PRIVATE_TABLE_NAMES } from "../schema/private-tables.js";

export interface SeatSnapshotResult {
  /** Where the snapshot was written. */
  readonly path: string;
  /** The log position the copy stands at; the seat tails from here. */
  readonly seq: number;
  readonly epoch: string;
  readonly schemaEpoch: number;
  readonly bytes: number;
  /** Private tables actually dropped — absent ones are not an error. */
  readonly droppedTables: readonly string[];
  /** Triggers, indexes and views dropped with them. */
  readonly droppedObjects: number;
  readonly elapsedMs: number;
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * An FTS sync trigger, by the only property that distinguishes it: it writes
 * to a shadow table. Matching on the NAME would be matching on a convention;
 * matching on the body is matching on what the trigger does.
 */
function isFtsSyncTrigger(sql: string | null): boolean {
  return sql !== null && /\bfts_[A-Za-z0-9_]+\b/u.test(sql);
}

/**
 * SQL minus its comments. Object DDL in this schema carries long explanatory
 * comments that name neighbouring tables, so matching raw text finds a private
 * table in the PROSE of an object that never reads it — which would drop a
 * live index because someone explained why it exists.
 */
export function withoutSqlComments(sql: string): string {
  return sql
    .replaceAll(/--[^\n]*/gu, " ")
    .replaceAll(/\/\*[\s\S]*?\*\//gu, " ");
}

export function namesPrivateTable(sql: string | null): boolean {
  if (sql === null) return false;
  const body = withoutSqlComments(sql);
  for (const table of PRIVATE_TABLE_NAMES) {
    if (new RegExp(`\\b${table}\\b`, "u").test(body)) return true;
  }
  return false;
}

/**
 * Build a seat snapshot of `vault` at `destination`.
 *
 * `vault` is only READ — `VACUUM INTO` writes a new file and the sanitisation
 * runs entirely on that copy, so a failure part-way leaves the gateway's own
 * file untouched and the half-built snapshot discardable.
 */
export function buildSeatSnapshot(
  vault: DatabaseSync,
  destination: string
): SeatSnapshotResult {
  const started = Date.now();
  const state = vault
    .prepare(`SELECT epoch, schema_epoch FROM replica_meta WHERE singleton = 1`)
    .get() as { epoch: string; schema_epoch: number } | undefined;
  if (!state) throw new Error("seat snapshot: replica metadata is missing");
  const seq = (
    vault
      .prepare(`SELECT MAX(seq) AS seq FROM replica_log WHERE epoch = ?`)
      .get(state.epoch) as { seq: number | null }
  ).seq;

  // 1. The copy. `VACUUM INTO` refuses an existing file, which is the
  //    behaviour we want: a snapshot never overwrites one already served.
  vault.prepare(`VACUUM INTO ?`).run(destination);

  const copy = new DatabaseSync(destination);
  const droppedTables: string[] = [];
  let droppedObjects = 0;
  try {
    // 2. Before any drop, not after: it governs how the pages are freed.
    copy.exec("PRAGMA secure_delete = ON");
    copy.exec("PRAGMA foreign_keys = OFF");

    const objects = copy
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_schema
          WHERE type IN ('trigger', 'index', 'view')`
      )
      .all() as {
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }[];

    // 3a. Every trigger except FTS sync. A seat is a mirror: it must not
    //     re-derive what the writer already committed, and a derivation
    //     trigger firing on an applied row would write a SECOND change the
    //     gateway never made.
    for (const object of objects) {
      if (object.type !== "trigger") continue;
      if (isFtsSyncTrigger(object.sql) && !namesPrivateTable(object.sql))
        continue;
      copy.exec(`DROP TRIGGER IF EXISTS ${quoted(object.name)}`);
      droppedObjects += 1;
    }
    // 3b. Indexes and views that name a private table, before the table goes:
    //     an index SQLite created implicitly is dropped with its table, but a
    //     view over one would survive as a broken object.
    for (const object of objects) {
      if (object.type === "trigger") continue;
      if (
        !PRIVATE_TABLE_NAMES.has(object.tbl_name) &&
        !namesPrivateTable(object.sql)
      )
        continue;
      if (object.name.startsWith("sqlite_autoindex")) continue;
      copy.exec(
        object.type === "view"
          ? `DROP VIEW IF EXISTS ${quoted(object.name)}`
          : `DROP INDEX IF EXISTS ${quoted(object.name)}`
      );
      droppedObjects += 1;
    }
    // 3c. The tables themselves.
    const present = new Set(
      (
        copy
          .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'`)
          .all() as { name: string }[]
      ).map((row) => row.name)
    );
    for (const table of PRIVATE_TABLE_NAMES) {
      if (!present.has(table)) continue;
      copy.exec(`DROP TABLE IF EXISTS ${quoted(table)}`);
      droppedTables.push(table);
    }

    // 4. The log goes; the cursor stays. `floor_seq` is where this file sits,
    //    so the seat's first tail request asks for exactly what it is missing.
    //    Both logs: `replica_change` is on its way out but a file frozen
    //    before it went still carries it, and on the year-3 corpus that is
    //    78,376 rows of a mechanism the seat has no reader for.
    copy.exec(`DELETE FROM replica_log`);
    if (
      copy
        .prepare(
          `SELECT 1 AS present FROM sqlite_schema
            WHERE type = 'table' AND name = 'replica_change'`
        )
        .get() !== undefined
    ) {
      copy.exec(`DELETE FROM replica_change`);
    }
    copy
      .prepare(
        `UPDATE replica_meta SET floor_seq = ?, active_commit_id = NULL
          WHERE singleton = 1`
      )
      .run(seq ?? 0);

    // 5. The step that actually reclaims the pages the drops freed.
    copy.exec("VACUUM");
  } finally {
    copy.close();
  }

  return {
    path: destination,
    seq: seq ?? 0,
    epoch: state.epoch,
    schemaEpoch: state.schema_epoch,
    bytes: statSync(destination).size,
    droppedTables,
    droppedObjects,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Does this file's BYTES contain `needle` anywhere — free pages included?
 *
 * The canary test's whole point is that `sqlite_schema` reading clean proves
 * nothing, so this deliberately does not open the file as a database. Chunked
 * with an overlap, because a needle can straddle a read boundary.
 */
export function fileContains(path: string, needle: string): boolean {
  const target = Buffer.from(needle, "utf8");
  const chunk = 1 << 20;
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(chunk);
    let position = 0;
    let tail = Buffer.alloc(0);
    for (;;) {
      const read = readSync(handle, buffer, 0, chunk, position);
      if (read === 0) return false;
      position += read;
      const window = Buffer.concat([tail, buffer.subarray(0, read)]);
      if (window.includes(target)) return true;
      // Carry the last needle-length-1 bytes so a needle split across two
      // reads is still found.
      tail = Buffer.from(
        window.subarray(Math.max(0, window.length - (target.length - 1)))
      );
    }
  } finally {
    closeSync(handle);
  }
}
