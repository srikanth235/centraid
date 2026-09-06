// governance: allow-repo-hygiene file-size-limit (#996) capture, decode and append are one transactional invariant
// THE GATEWAY LOG: CAPTURE, DECODE, APPEND (#996, ruling R5).
//
// WHAT THIS REPLACES, AND WHY. Until now every replicated table carried three
// AFTER triggers that wrote a row into `replica_change` — 288 of them on a
// fresh vault, generated from the entity registry, each one re-derived on
// every schema change. They were correct, and they were the wrong mechanism:
// a trigger can only write what JSON1 can express, so BLOBs became NULL; it
// fires per STATEMENT, so one logical change wrote several rows; and its cost
// is paid on the write path of every table forever. SQLite already knows what
// a transaction touched — the session extension is that knowledge — so the log
// stops being something the schema maintains and becomes something the commit
// reports.
//
// THE ONE HARD PART. A session changeset is not a row image: an UPDATE record
// carries only the columns the statement touched, and the primary key. The
// decoder therefore READS THE ROW BACK, by the changeset's own primary-key
// flags, from the same connection, INSIDE the capturing transaction. It has to
// be inside: with one session per table and the read deferred to just before
// COMMIT, a row updated by session 1 and deleted by session 7 reads NO ROW,
// and the decoder would emit an update for a row that no longer exists. A
// post-commit read is unsafe for exactly the same reason.

import type { DatabaseSync, StatementSync } from "node:sqlite";

import { encodeWireValue } from "@centraid/core/protocol";
import type { WireValue } from "@centraid/core/protocol";

import { replicatedTablesOf } from "../schema/private-tables.js";
import {
  REPLICA_DDL_VERSION,
  REPLICA_SCHEMA_EPOCH,
} from "../schema/replica.js";
import { changesetValueToBindable, parseChangeset } from "./changeset.js";
import type { ChangesetChange, ChangesetValue } from "./changeset.js";

export type ReplicaLogOp = "insert" | "update" | "delete" | "ddl";

export interface ReplicaLogRow {
  readonly seq: number;
  readonly commitSeq: number;
  readonly epoch: string;
  readonly schemaEpoch: number;
  readonly ddlVersion: number;
  readonly table: string;
  readonly op: ReplicaLogOp;
  /** Primary-key values, in declared key order. */
  readonly primaryKey: readonly WireValue[];
  /** Full row image for insert/update; full OLD image for delete. */
  readonly row: Readonly<Record<string, WireValue>> | null;
  readonly indirect: boolean;
  readonly producer: string;
  readonly committedAt: string;
}

/** What one capture produced. `rows` is 0 when the commit touched nothing. */
export interface ReplicaCaptureResult {
  readonly commitSeq: number;
  readonly rows: number;
  readonly tables: readonly string[];
}

interface OpenSession {
  readonly table: string;
  readonly session: { changeset: () => Uint8Array; close: () => void };
}

interface CaptureState {
  sessions: OpenSession[];
  producer: string;
  /** Reused across a batch; a fresh statement per row is most of the cost. */
  readonly reads: Map<string, StatementSync>;
}

// Per CONNECTION, because a session belongs to the connection that opened it
// and the gateway may hold several (`db.ts` opens a reader beside the writer).
const CAPTURES = new WeakMap<DatabaseSync, CaptureState>();

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * The primary key of a table, in declared order. A table with none is a table
 * the session extension SILENTLY DOES NOT TRACK — so this throws rather than
 * returning empty, and the throw is the only thing standing between a missing
 * key and a table that quietly stops replicating.
 */
export function primaryKeyOf(vault: DatabaseSync, table: string): string[] {
  const columns = vault
    .prepare(`PRAGMA table_info(${quoted(table)})`)
    .all() as { name: string; pk: number }[];
  const key = columns
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  if (key.length === 0) {
    throw new Error(
      `replica log: ${table} declares no PRIMARY KEY; the session extension does not track it and its rows would never replicate`
    );
  }
  return key;
}

/**
 * Open one session per replicated table on this connection.
 *
 * ONE PER TABLE IS MANDATORY, not a style choice: `createSession({ filter })`
 * is ACCEPTED AND SILENTLY IGNORED by `node:sqlite` on both 3.50.2 and 3.51.2
 * — an excluded row still ships — so a single filtered session would carry the
 * private tables it was asked not to. Measured cost of the whole set is about
 * 2 ms per commit.
 */
export function openReplicaCapture(
  vault: DatabaseSync,
  producer = "gateway"
): void {
  const existing = CAPTURES.get(vault);
  if (existing) {
    existing.producer = producer;
    return;
  }
  const sessions: OpenSession[] = [];
  for (const table of replicatedTablesOf(vault)) {
    sessions.push({
      table,
      session: vault.createSession({ table }) as OpenSession["session"],
    });
  }
  CAPTURES.set(vault, { sessions, producer, reads: new Map() });
}

/** Drop the sessions without decoding — the rollback path. */
export function closeReplicaCapture(vault: DatabaseSync): void {
  const state = CAPTURES.get(vault);
  if (!state) return;
  for (const open of state.sessions) open.session.close();
  CAPTURES.delete(vault);
}

export function replicaCaptureOpen(vault: DatabaseSync): boolean {
  return CAPTURES.has(vault);
}

function primaryKeyValues(
  change: ChangesetChange,
  record: readonly ChangesetValue[]
): ChangesetValue[] {
  const key: ChangesetValue[] = [];
  for (let index = 0; index < change.columnCount; index += 1) {
    if (change.primaryKeyFlags[index]) key.push(record[index]!);
  }
  return key;
}

function encodeKey(values: readonly ChangesetValue[]): WireValue[] {
  return values.map((value) =>
    encodeWireValue(changesetValueToBindable(value))
  );
}

interface DecodedRow {
  table: string;
  op: ReplicaLogOp;
  key: WireValue[];
  row: Record<string, WireValue> | null;
  indirect: boolean;
}

/**
 * Turn one table's changeset into log rows, reading each touched row back from
 * `vault` for the full image.
 *
 * ONE ROW PER (TABLE, KEY) PER COMMIT. The collapse is the SESSION's, not
 * ours: it groups by table then by key, and intra-commit statement order is
 * not recoverable from the wire. That is not a loss — a log row says "this is
 * what the row is now", and a subscriber applies end state under last-write-
 * wins. The map below only guards against a malformed changeset carrying the
 * same key twice.
 */
export function decodeChangeset(
  vault: DatabaseSync,
  table: string,
  changeset: Uint8Array,
  reads: Map<string, StatementSync>
): DecodedRow[] {
  if (changeset.length === 0) return [];
  const changes = parseChangeset(changeset);
  if (changes.length === 0) return [];
  const key = primaryKeyOf(vault, table);
  let read = reads.get(table);
  if (!read) {
    read = vault.prepare(
      `SELECT * FROM ${quoted(table)} WHERE ` +
        key.map((column) => `${quoted(column)} = ?`).join(" AND ")
    );
    reads.set(table, read);
  }
  const decoded: DecodedRow[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    if (change.table !== table) {
      // One session per table, so this cannot happen without the session
      // extension having changed under us. Fail rather than mislabel a row.
      throw new Error(
        `replica log: session for ${table} emitted a change for ${change.table}`
      );
    }
    const record =
      change.op === "delete" ? change.oldValues! : change.newValues!;
    const keyValues = primaryKeyValues(
      change,
      change.op === "update" ? change.oldValues! : record
    );
    const encodedKey = encodeKey(keyValues);
    const identity = JSON.stringify(encodedKey);
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (change.op === "delete") {
      // A DELETE record carries EVERY column of the old row, so this is the
      // one op whose image needs no read — and the one whose row is gone.
      const image: Record<string, WireValue> = {};
      const columns = tableColumnNames(vault, table, reads);
      for (let index = 0; index < change.columnCount; index += 1) {
        const column = columns[index];
        if (column === undefined) continue;
        const value = change.oldValues![index]!;
        if (value.kind === "absent") continue;
        image[column] = encodeWireValue(changesetValueToBindable(value));
      }
      decoded.push({
        table,
        op: "delete",
        key: encodedKey,
        row: image,
        indirect: change.indirect,
      });
      continue;
    }
    const current = read.get(
      ...keyValues.map((value) => changesetValueToBindable(value))
    ) as Record<string, unknown> | undefined;
    if (current === undefined) {
      throw new Error(
        `replica log: ${table} row ${identity} was ${change.op}ed but reads back as missing; the decode ran outside its transaction`
      );
    }
    const image: Record<string, WireValue> = {};
    for (const [column, value] of Object.entries(current))
      image[column] = encodeWireValue(value);
    decoded.push({
      table,
      op: change.op,
      key: encodedKey,
      row: image,
      indirect: change.indirect,
    });
  }
  return decoded;
}

const COLUMN_NAMES = new WeakMap<DatabaseSync, Map<string, string[]>>();

function tableColumnNames(
  vault: DatabaseSync,
  table: string,
  _reads: Map<string, StatementSync>
): string[] {
  let perDb = COLUMN_NAMES.get(vault);
  if (!perDb) {
    perDb = new Map();
    COLUMN_NAMES.set(vault, perDb);
  }
  let names = perDb.get(table);
  if (!names) {
    names = (
      vault.prepare(`PRAGMA table_info(${quoted(table)})`).all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    perDb.set(table, names);
  }
  return names;
}

interface MetaRow {
  epoch: string;
  floor_seq: number;
  schema_epoch: number;
  commit_seq: number;
  epoch_reason: string;
  epoch_started_at: string;
}

function meta(vault: DatabaseSync): MetaRow {
  const row = vault
    .prepare(
      `SELECT epoch, floor_seq, schema_epoch, commit_seq, epoch_reason, epoch_started_at
         FROM replica_meta WHERE singleton = 1`
    )
    .get() as MetaRow | undefined;
  if (!row) throw new Error("replica metadata is missing");
  return row;
}

/**
 * Decode every open session and append its rows, IN THE CALLER'S TRANSACTION.
 *
 * The mutation and its log rows commit together or not at all — there is no
 * window in which a row changed and the log does not say so, and none in which
 * the log claims a change that rolled back. That is the atomicity invariant,
 * and it is a property of WHERE this runs, not of anything it does.
 */
export function captureReplicaCommit(
  vault: DatabaseSync,
  options: { producer?: string; committedAt?: string } = {}
): ReplicaCaptureResult | undefined {
  const state = CAPTURES.get(vault);
  if (!state) return undefined;
  const producer = options.producer ?? state.producer;
  const decoded: DecodedRow[] = [];
  const tables: string[] = [];
  for (const open of state.sessions) {
    const changeset = open.session.changeset();
    if (changeset.length === 0) continue;
    // PER SESSION, IMMEDIATELY: the read has to happen before any later
    // statement in this transaction can move the row it is about to read.
    const rows = decodeChangeset(vault, open.table, changeset, state.reads);
    if (rows.length === 0) continue;
    tables.push(open.table);
    decoded.push(...rows);
  }
  // Sessions are one-shot per commit: closing and reopening is how the next
  // transaction starts from empty rather than replaying this one.
  closeReplicaCapture(vault);
  openReplicaCapture(vault, producer);
  if (decoded.length === 0) return undefined;
  const current = meta(vault);
  const commitSeq = current.commit_seq + 1;
  vault
    .prepare(
      `UPDATE replica_meta SET commit_seq = ?, updated_at = ? WHERE singleton = 1`
    )
    .run(commitSeq, new Date().toISOString());
  const committedAt = options.committedAt ?? new Date().toISOString();
  const insert = vault.prepare(
    `INSERT INTO replica_log
       (commit_seq, epoch, schema_epoch, ddl_version, "table", op,
        pk_json, row_json, indirect, producer, committed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of decoded) {
    insert.run(
      commitSeq,
      current.epoch,
      REPLICA_SCHEMA_EPOCH,
      REPLICA_DDL_VERSION,
      row.table,
      row.op,
      JSON.stringify(row.key),
      row.row === null ? null : JSON.stringify(row.row),
      row.indirect ? 1 : 0,
      producer,
      committedAt
    );
  }
  return { commitSeq, rows: decoded.length, tables };
}

export interface ReplicaLogCursor {
  readonly epoch: string;
  readonly seq: number;
}

export interface ReplicaLogState {
  readonly epoch: string;
  readonly schemaEpoch: number;
  readonly ddlVersion: number;
  readonly floor: ReplicaLogCursor;
  readonly watermark: ReplicaLogCursor;
  readonly commitSeq: number;
}

export function replicaLogState(vault: DatabaseSync): ReplicaLogState {
  const row = meta(vault);
  const latest = vault
    .prepare(`SELECT MAX(seq) AS seq FROM replica_log WHERE epoch = ?`)
    .get(row.epoch) as { seq: number | null };
  return {
    epoch: row.epoch,
    schemaEpoch: row.schema_epoch,
    ddlVersion: REPLICA_DDL_VERSION,
    floor: { epoch: row.epoch, seq: row.floor_seq },
    watermark: {
      epoch: row.epoch,
      seq: Math.max(row.floor_seq, latest.seq ?? 0),
    },
    commitSeq: row.commit_seq,
  };
}

interface LogRowSql {
  seq: number;
  commit_seq: number;
  epoch: string;
  schema_epoch: number;
  ddl_version: number;
  table: string;
  op: ReplicaLogOp;
  pk_json: string;
  row_json: string | null;
  indirect: number;
  producer: string;
  committed_at: string;
}

function logRow(row: LogRowSql): ReplicaLogRow {
  return {
    seq: row.seq,
    commitSeq: row.commit_seq,
    epoch: row.epoch,
    schemaEpoch: row.schema_epoch,
    ddlVersion: row.ddl_version,
    table: row.table,
    op: row.op,
    primaryKey: JSON.parse(row.pk_json) as WireValue[],
    row:
      row.row_json === null
        ? null
        : (JSON.parse(row.row_json) as Record<string, WireValue>),
    indirect: row.indirect === 1,
    producer: row.producer,
    committedAt: row.committed_at,
  };
}

export interface ReplicaLogPage {
  readonly rows: readonly ReplicaLogRow[];
  readonly next: ReplicaLogCursor;
  readonly watermark: ReplicaLogCursor;
  readonly floor: ReplicaLogCursor;
  readonly schemaEpoch: number;
  readonly hasMore: boolean;
}

export type ReplicaRebootstrapReason =
  | "epoch-mismatch"
  | "retention"
  | "cursor-ahead";

export class ReplicaRebootstrapRequiredError extends Error {
  constructor(
    readonly reason: ReplicaRebootstrapReason,
    readonly state: ReplicaLogState
  ) {
    super(`replica bootstrap required: ${reason}`);
    this.name = "ReplicaRebootstrapRequiredError";
  }
}

/**
 * A page of the log, NEVER half a commit.
 *
 * The page limit is a hint: once the last row inside it is chosen, the rest of
 * that row's commit is appended whatever the limit says. A seat applies one
 * commit per transaction with its cursor in the same transaction, so a page
 * that ends mid-commit would force it to either hold an open transaction
 * across a round trip or write a state no single transaction produced.
 */
export function readReplicaLog(
  vault: DatabaseSync,
  options: { since?: ReplicaLogCursor; limit?: number } = {}
): ReplicaLogPage {
  const state = replicaLogState(vault);
  const since = options.since ?? state.floor;
  if (since.epoch !== state.epoch)
    throw new ReplicaRebootstrapRequiredError("epoch-mismatch", state);
  if (since.seq < state.floor.seq)
    throw new ReplicaRebootstrapRequiredError("retention", state);
  if (since.seq > state.watermark.seq)
    throw new ReplicaRebootstrapRequiredError("cursor-ahead", state);
  const limit = options.limit ?? 1_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new RangeError(
      "replica log page limit must be an integer between 1 and 10000"
    );
  }
  const rows = vault
    .prepare(
      `SELECT seq, commit_seq, epoch, schema_epoch, ddl_version, "table",
              op, pk_json, row_json, indirect, producer, committed_at
         FROM replica_log
        WHERE epoch = ? AND seq > ? AND seq <= ?
        ORDER BY seq LIMIT ?`
    )
    .all(
      state.epoch,
      since.seq,
      state.watermark.seq,
      limit
    ) as unknown as LogRowSql[];
  let page = rows;
  const last = page.at(-1);
  if (last) {
    const tail = vault
      .prepare(
        `SELECT seq, commit_seq, epoch, schema_epoch, ddl_version, "table",
                op, pk_json, row_json, indirect, producer, committed_at
           FROM replica_log
          WHERE epoch = ? AND commit_seq = ? AND seq > ? AND seq <= ?
          ORDER BY seq`
      )
      .all(
        state.epoch,
        last.commit_seq,
        last.seq,
        state.watermark.seq
      ) as unknown as LogRowSql[];
    if (tail.length > 0) page = [...page, ...tail];
  }
  const end = page.at(-1);
  const hasMore = Boolean(
    end &&
    vault
      .prepare(
        `SELECT 1 AS present FROM replica_log
            WHERE epoch = ? AND seq > ? AND seq <= ? LIMIT 1`
      )
      .get(state.epoch, end.seq, state.watermark.seq)
  );
  return {
    rows: page.map(logRow),
    next:
      hasMore && end ? { epoch: state.epoch, seq: end.seq } : state.watermark,
    watermark: state.watermark,
    floor: state.floor,
    schemaEpoch: state.schemaEpoch,
    hasMore,
  };
}
