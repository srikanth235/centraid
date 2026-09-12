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
import { gzipSync } from "node:zlib";

import { encodeWireValue } from "@centraid/core/protocol";
import type { SeatLogRowWire, WireValue } from "@centraid/core/protocol";

import {
  isPrivateTable,
  isReplicatedTable,
  replicatedTablesOf,
} from "../schema/private-tables.js";
import {
  REPLICA_DDL_VERSION,
  REPLICA_SCHEMA_EPOCH,
} from "../schema/replica.js";
import { changesetValueToBindable, parseChangeset } from "./changeset.js";
import type { ChangesetChange, ChangesetValue } from "./changeset.js";

export type ReplicaLogOp = "insert" | "update" | "delete" | "ddl";

/**
 * THE PRODUCER BOUND (#996, R5; open question 3), in DECODED LOG ROWS.
 *
 * A bulk writer — an enrichment sweep, an import, a model upgrade re-deriving
 * a library — chunks its work to at most this many rows per commit, so no
 * single commit can straddle the defer threshold and a deferred span leaves
 * the seat consistent behind it rather than half-applied.
 *
 * 2,000 is measured, not chosen. At year-3 volume a 2,000-row commit is at
 * most 1.4 MB of `row_json` and about 38 KB gzip-6 — under 4% of the
 * threshold below, so a conforming producer cannot produce a deferrable
 * commit by accident. Chunking to 2,000 costs +0.7…+1.6% total compressed
 * bytes against one 10,000-row commit; 500 costs +2.2…+6.8% and 250 costs
 * +7.9…+13%, which is what makes 2,000 the knee rather than "a round number".
 */
export const REPLICA_PRODUCER_MAX_ROWS = 2_000;

/**
 * THE DEFER THRESHOLD, in COMPRESSED BYTES — never in rows.
 *
 * The same 10,000-row commit measures 55 KB, 209 KB or 184 KB gzipped
 * depending on whether it is deletes, inserts or updates: a 6.6x spread. A
 * row-denominated threshold would therefore defer a cheap commit and admit an
 * expensive one, which is the opposite of what a metered connection needs.
 *
 * 1 MB is the middle of the measured 512 KB – 2 MB band: roughly 55,000 log
 * rows worst case and 360,000 best on one unattended cellular catch-up.
 */
export const REPLICA_DEFER_THRESHOLD_BYTES = 1_000_000;

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
  /** This commit crossed the defer threshold; a metered seat may skip it. */
  readonly deferred: boolean;
  readonly committedAt: string;
}

/**
 * A log row as the seat door serves it (#996, R5).
 *
 * The door is HTTP, but the shaping is not: the fixtures that build a seat
 * file in-process and the parity run both have to serve exactly what the door
 * serves, so the wire form of a row is written once, here, beside the row.
 * `indirect` and `deferred` are omitted rather than sent false — the wire says
 * a row is unusual, and says nothing about an ordinary one.
 */
export function seatLogRowWire(row: ReplicaLogRow): SeatLogRowWire {
  return {
    seq: row.seq,
    commitSeq: row.commitSeq,
    schemaEpoch: row.schemaEpoch,
    ddlVersion: row.ddlVersion,
    table: row.table,
    op: row.op,
    pk: row.primaryKey,
    ...(row.row === null ? {} : { row: row.row }),
    ...(row.indirect ? { indirect: true as const } : {}),
    ...(row.deferred ? { deferred: true as const } : {}),
    producer: row.producer,
    committedAt: row.committedAt,
  };
}

/** What one capture produced. `rows` is 0 when the commit touched nothing. */
export interface ReplicaCaptureResult {
  readonly commitSeq: number;
  readonly rows: number;
  readonly tables: readonly string[];
  /** Compressed size of this commit's row images. */
  readonly compressedBytes: number;
  /** True when this commit crossed {@link REPLICA_DEFER_THRESHOLD_BYTES}. */
  readonly deferred: boolean;
  /**
   * THE ROWS THIS COMMIT PRODUCED, with the version each landed at (#996,
   * R24). An executed intent's outcome carries this set, so a seat can decide
   * "my pending projection stands for THESE rows at THESE versions" instead of
   * guessing from a cursor — which is what makes a pending badge clear at the
   * right moment rather than one round trip early.
   *
   * Read from the decoded images, never re-queried: the image is what the
   * commit actually wrote, and a second read could see a later commit's value.
   */
  readonly produced: readonly ReplicaProducedRow[];
}

export interface ReplicaProducedRow {
  readonly table: string;
  readonly primaryKey: readonly WireValue[];
  /** Absent on a table with no `row_version` — a delete, or an append-only row. */
  readonly rowVersion?: number;
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

/**
 * WATCH A TABLE THAT DID NOT EXIST WHEN THE CAPTURE OPENED (#1014, G21).
 *
 * `openReplicaCapture` enumerates the replicated tables ONCE and re-runs only
 * at the tail of the next successful capture, so DDL that plants a new
 * physical mid-session — an app's ext band being installed, `recreateExtTables`
 * on the import path — left every row written into it before the next commit
 * with no session watching, and those rows never reached a seat.
 *
 * ADDITIVE, NEVER A REOPEN: closing and reopening the whole set would discard
 * the changesets the open sessions are already holding for this transaction.
 * A table already watched is a no-op, so this is safe to call after any DDL.
 */
export function watchReplicaTable(vault: DatabaseSync, table: string): void {
  const state = CAPTURES.get(vault);
  if (!state) return;
  if (!isReplicatedTable(table) || isPrivateTable(table)) return;
  if (state.sessions.some((open) => open.table === table)) return;
  state.sessions.push({
    table,
    session: vault.createSession({ table }) as OpenSession["session"],
  });
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

// KEYED ON `PRAGMA schema_version`, LIKE `REPLICATED` (#1014, G15). These
// names are the SOLE source of column order for a DELETE image, which is
// positional: the changeset gives values by index and nothing else says what
// they are. A cache that never invalidated meant that after `alterExtTable`
// dropped a column every delete row for that table carried its values under
// the wrong keys — and a seat applied it. SQLite's own counter is bumped by
// every table, index and trigger change, including one an ext band installs
// mid-session, so it is the only notion of "the schema moved" that cannot
// disagree with the schema.
const COLUMN_NAMES = new WeakMap<
  DatabaseSync,
  { schemaVersion: number; names: Map<string, string[]> }
>();

function schemaVersionOf(vault: DatabaseSync): number {
  return (
    vault.prepare("PRAGMA schema_version").get() as { schema_version: number }
  ).schema_version;
}

function tableColumnNames(
  vault: DatabaseSync,
  table: string,
  _reads: Map<string, StatementSync>
): string[] {
  const schemaVersion = schemaVersionOf(vault);
  let cached = COLUMN_NAMES.get(vault);
  if (!cached || cached.schemaVersion !== schemaVersion) {
    cached = { schemaVersion, names: new Map() };
    COLUMN_NAMES.set(vault, cached);
  }
  let names = cached.names.get(table);
  if (!names) {
    names = (
      vault.prepare(`PRAGMA table_info(${quoted(table)})`).all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    cached.names.set(table, names);
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
  const images = decoded.map((row) =>
    row.row === null ? null : JSON.stringify(row.row)
  );
  // A CONFORMING PRODUCER IS NEVER MEASURED — BUT "CONFORMING" IS ABOUT BYTES
  // (#1014, G20). The bound below is stated in rows, and the guarantee behind
  // it ("~38 KB gzipped") holds only for rows of ordinary size. A 2,000-row
  // commit of `enrich_embedding` BLOB images is tens of megabytes and used to
  // report `deferred: false`, so the one commit a metered seat most needed to
  // skip was the one the threshold could not see. The uncompressed image size
  // is already in hand — it costs a sum, not a compression — so a commit is
  // measured when EITHER its row count or its raw image bytes could plausibly
  // reach the threshold.
  const rawBytes = images.reduce(
    (total, image) => total + (image === null ? 0 : image.length),
    0
  );
  const compressedBytes =
    decoded.length > REPLICA_PRODUCER_MAX_ROWS ||
    rawBytes > REPLICA_DEFER_THRESHOLD_BYTES
      ? gzipSync(Buffer.from(images.join("\n"), "utf8"), { level: 6 }).length
      : 0;
  const deferred = compressedBytes > REPLICA_DEFER_THRESHOLD_BYTES;
  const insert = vault.prepare(
    `INSERT INTO replica_log
       (commit_seq, epoch, schema_epoch, ddl_version, "table", op,
        pk_json, row_json, indirect, producer, deferred, committed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const [index, row] of decoded.entries()) {
    insert.run(
      commitSeq,
      current.epoch,
      REPLICA_SCHEMA_EPOCH,
      REPLICA_DDL_VERSION,
      row.table,
      row.op,
      JSON.stringify(row.key),
      images[index] ?? null,
      row.indirect ? 1 : 0,
      producer,
      deferred ? 1 : 0,
      committedAt
    );
  }
  return {
    commitSeq,
    rows: decoded.length,
    tables,
    compressedBytes,
    deferred,
    produced: decoded.map((row) => {
      const version = row.row?.["row_version"];
      return {
        table: row.table,
        primaryKey: row.key,
        ...(typeof version === "number" ? { rowVersion: version } : {}),
      };
    }),
  };
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
  deferred: number;
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
    deferred: row.deferred === 1,
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
/**
 * Run a read as ONE STABLE VIEW of the file (#1014, G6).
 *
 * Re-entrant on purpose: the projection plane already brackets its reads with
 * `withReplicaSnapshot`, and a nested `BEGIN` is an error rather than a
 * nesting. `ROLLBACK` rather than `COMMIT` because nothing here writes.
 */
export function inReadTransaction<T>(vault: DatabaseSync, read: () => T): T {
  if (vault.isTransaction) return read();
  vault.exec("BEGIN");
  try {
    const value = read();
    vault.exec("ROLLBACK");
    return value;
  } catch (error) {
    try {
      vault.exec("ROLLBACK");
    } catch {
      // The read already failed; a failed rollback must not mask why.
    }
    throw error;
  }
}

export function readReplicaLog(
  vault: DatabaseSync,
  options: { since?: ReplicaLogCursor; limit?: number } = {}
): ReplicaLogPage {
  return inReadTransaction(vault, () => readReplicaLogRows(vault, options));
}

/**
 * THE FOUR STATEMENTS THAT HAVE TO AGREE (#1014, G6): state, rows, the tail
 * of the last commit, and `hasMore`. Run apart, a prune of `(since,
 * watermark]` landing between them yielded no rows, `hasMore: false` and
 * `next: watermark` — and the seat skipped a span it never received, silently.
 * Its caller brackets it; it is separate only so the bracket is re-entrant.
 */
function readReplicaLogRows(
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
              op, pk_json, row_json, indirect, producer, deferred, committed_at
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
                op, pk_json, row_json, indirect, producer, deferred, committed_at
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

// ---------------------------------------------------------------------------
// RETENTION (#996, R5; open question 13).
//
// THERE IS NO COMPACTION. The old change log folded superseded entries so a
// churn-heavy vault could keep a long cursor window without unbounded growth;
// that machinery existed because a change entry was a POINTER — "row X
// changed" — and several of them for one row said nothing more than the last.
// A log row is a full image, so folding buys nothing a truncation does not,
// and it cost a `prior_op` / `prior_old_values_json` pair on every row plus a
// scan that had to reason about filtered membership.
//
// WHAT REPLACES IT IS A FLOOR. Below `floor_seq` the log is gone and a seat
// that far behind re-bootstraps from a snapshot — which is a file copy, not a
// replay, so "start over" is cheap in a way it never was when a bootstrap
// meant walking the vault.
//
// TWO THINGS THE FLOOR MAY NOT CROSS:
//   - A COMMIT EDGE. The floor lands on a commit boundary, never inside one,
//     or a seat resuming at the floor gets half a transaction.
//   - A DEVICE'S CURSOR. Pruning past a live seat's position converts a
//     cheap tail into a forced re-bootstrap, silently, on the gateway's
//     schedule rather than the member's.

export const REPLICA_LOG_RETENTION_DAYS = 30;
export const REPLICA_LOG_RETENTION_MAX_ROWS = 200_000;

/**
 * HOW LONG A SEAT'S CURSOR PINS THE LOG (#1014, T9).
 *
 * The hold exists so a prune cannot convert a cheap tail into a forced
 * re-bootstrap on the gateway's schedule. It needs a bound for the opposite
 * failure: a phone that is lost, wiped or simply never opened again holds a
 * cursor forever, and with it every log row above that cursor — which is the
 * unbounded growth the retention window was written to stop.
 *
 * 30 days is the retention window itself; the hold is shorter on purpose, so
 * a device that has not asked for a page in this long stops pinning BEFORE
 * the window it is pinning would have expired anyway. A device that comes
 * back after the bound re-bootstraps from a snapshot — visibly, once — which
 * is the outcome a member can understand.
 */
export const REPLICA_SEAT_HOLD_DAYS = 14;

export interface PruneReplicaLogOptions {
  now?: Date;
  maxAgeMs?: number;
  maxRows?: number;
  /**
   * The lowest seq any seat still needs. Nothing at or above it is pruned.
   * Defaults to the lowest `access_device_secret.sync_cursor` — the gateway's
   * own record of how far it has served each device (#996, R3).
   */
  holdAtOrAbove?: number;
}

export interface ReplicaLogPruneResult {
  readonly pruned: number;
  readonly retained: number;
  readonly floor: ReplicaLogCursor;
  /** The seat cursor that stopped the prune, when one did. */
  readonly heldBySeat: number | undefined;
}

/**
 * RECORD WHERE A SEAT HAS ACTUALLY GOT TO (#1014, V1/T9).
 *
 * The hold below reads `access_device_secret.sync_cursor`, which until now was
 * only ever written NULL at enrollment — so the guard on the prune was inert
 * and the day the prune was wired it would have pruned past every live seat.
 * The seat-log door calls this with the cursor the device SENT, not the one it
 * was served: the sent cursor is the position the device has, and the hold has
 * to stand on what a seat has rather than on what is in flight to it.
 *
 * BEST-EFFORT, LIKE A DOORBELL: this is bookkeeping about a page that has
 * already been served, so a failure here may never fail the page. It returns
 * whether it wrote, for the door's own logging.
 */
export function recordSeatCursor(
  vault: DatabaseSync,
  deviceId: string,
  seq: number,
  now: Date = new Date()
): boolean {
  if (!Number.isSafeInteger(seq) || seq < 0) return false;
  try {
    return (
      Number(
        vault
          .prepare(
            `UPDATE access_device_secret
                SET sync_cursor = ?, sync_cursor_at = ?
              WHERE device_id = ?
                AND (sync_cursor IS NULL OR CAST(sync_cursor AS INTEGER) <= ?)`
          )
          .run(String(seq), now.toISOString(), deviceId, seq).changes
      ) > 0
    );
  } catch {
    return false;
  }
}

export interface LowestSeatCursorOptions {
  now?: Date;
  /** Defaults to {@link REPLICA_SEAT_HOLD_DAYS}. */
  abandonAfterMs?: number;
}

/**
 * The lowest position any LIVE enrolled seat still needs served.
 *
 * A cursor with no `sync_cursor_at`, or one older than the abandonment bound,
 * does not pin: it is a device that has not come to the door inside the window
 * (#1014, T9). A device that never asked at all never had a cursor to begin
 * with, so it cannot hold a floor it has no position in.
 */
export function lowestSeatCursor(
  vault: DatabaseSync,
  options: LowestSeatCursorOptions = {}
): number | undefined {
  const abandonAfterMs =
    options.abandonAfterMs ?? REPLICA_SEAT_HOLD_DAYS * 24 * 60 * 60 * 1_000;
  const now = options.now ?? new Date();
  const since = new Date(
    Math.max(0, now.getTime() - abandonAfterMs)
  ).toISOString();
  const row = vault
    .prepare(
      `SELECT MIN(CAST(sync_cursor AS INTEGER)) AS seq
         FROM access_device_secret
        WHERE sync_cursor IS NOT NULL
          AND sync_cursor_at IS NOT NULL
          AND sync_cursor_at >= ?`
    )
    .get(since) as { seq: number | null } | undefined;
  return row?.seq ?? undefined;
}

/**
 * The lowest COMMIT position any live seat still needs — the same hold as
 * {@link lowestSeatCursor}, in the units an intent outcome speaks (#1014, G17).
 *
 * A seat cursor is a `replica_log.seq`; an outcome's `commit_seq` is the
 * transaction that seq belongs to. Comparing one against the other is the R6
 * mistake in miniature — 432 against 2 — so the translation happens here,
 * once, rather than at the caller. `undefined` when no live seat holds a
 * position, which is what "nothing is pinning" means.
 */
export function lowestSeatCommitSeq(
  vault: DatabaseSync,
  options: LowestSeatCursorOptions = {}
): number | undefined {
  const seq = lowestSeatCursor(vault, options);
  if (seq === undefined) return undefined;
  const epoch = meta(vault).epoch;
  const row = vault
    .prepare(
      `SELECT commit_seq FROM replica_log
        WHERE epoch = ? AND seq <= ? ORDER BY seq DESC LIMIT 1`
    )
    .get(epoch, seq) as { commit_seq: number } | undefined;
  // A cursor below every row this epoch holds pins from the very beginning.
  return row?.commit_seq ?? 0;
}

/** The highest seq that ends a whole commit at or below `through`. */
function commitEdgeAtOrBelow(
  vault: DatabaseSync,
  epoch: string,
  through: number
): number {
  if (through <= 0) return 0;
  const commit = vault
    .prepare(
      `SELECT commit_seq FROM replica_log
        WHERE epoch = ? AND seq <= ? ORDER BY seq DESC LIMIT 1`
    )
    .get(epoch, through) as { commit_seq: number } | undefined;
  if (!commit) return 0;
  // The commit the boundary lands in is kept WHOLE — the floor moves to the
  // end of the previous one.
  const previous = vault
    .prepare(
      `SELECT MAX(seq) AS seq FROM replica_log
        WHERE epoch = ? AND commit_seq < ?`
    )
    .get(epoch, commit.commit_seq) as { seq: number | null };
  return previous.seq ?? 0;
}

export function pruneReplicaLog(
  vault: DatabaseSync,
  options: PruneReplicaLogOptions = {}
): ReplicaLogPruneResult {
  const maxAgeMs =
    options.maxAgeMs ?? REPLICA_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
  const maxRows = options.maxRows ?? REPLICA_LOG_RETENTION_MAX_ROWS;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0)
    throw new RangeError("replica retention maxAgeMs must be non-negative");
  if (!Number.isSafeInteger(maxRows) || maxRows < 0)
    throw new RangeError("replica retention maxRows must be non-negative");
  const now = options.now ?? new Date();
  // Clamped at the epoch, so a caller saying "never prune by age" with a huge
  // window gets that answer rather than an Invalid Date.
  const cutoff = new Date(Math.max(0, now.getTime() - maxAgeMs)).toISOString();
  const epoch = meta(vault).epoch;
  const heldBySeat = options.holdAtOrAbove ?? lowestSeatCursor(vault, { now });

  let pruned = 0;
  vault.exec("BEGIN IMMEDIATE");
  try {
    // Another epoch's rows stand for a contract nothing can resume across.
    pruned += Number(
      vault.prepare(`DELETE FROM replica_log WHERE epoch <> ?`).run(epoch)
        .changes
    );

    const byAge = (
      vault
        .prepare(
          `SELECT MAX(seq) AS seq FROM replica_log
            WHERE epoch = ? AND committed_at < ?`
        )
        .get(epoch, cutoff) as { seq: number | null }
    ).seq;
    const total = (
      vault
        .prepare(`SELECT COUNT(*) AS n FROM replica_log WHERE epoch = ?`)
        .get(epoch) as { n: number }
    ).n;
    const byCount =
      total > maxRows
        ? ((
            vault
              .prepare(
                `SELECT seq FROM replica_log WHERE epoch = ?
                  ORDER BY seq LIMIT 1 OFFSET ?`
              )
              .get(epoch, total - maxRows - 1) as { seq: number } | undefined
          )?.seq ?? 0)
        : 0;

    let through = Math.max(byAge ?? 0, byCount);
    // A seat that is behind holds the floor where it is. Its own cursor is
    // the last position it HAS, so the row at that seq may go and the next
    // may not.
    if (heldBySeat !== undefined) through = Math.min(through, heldBySeat);
    through = commitEdgeAtOrBelow(vault, epoch, through);
    if (through > 0) {
      pruned += Number(
        vault
          .prepare(`DELETE FROM replica_log WHERE epoch = ? AND seq <= ?`)
          .run(epoch, through).changes
      );
      vault
        .prepare(
          `UPDATE replica_meta SET floor_seq = MAX(floor_seq, ?), updated_at = ?
            WHERE singleton = 1`
        )
        .run(through, now.toISOString());
    }
    vault.exec("COMMIT");
  } catch (error) {
    vault.exec("ROLLBACK");
    throw error;
  }
  const state = replicaLogState(vault);
  return {
    pruned,
    retained: (
      vault
        .prepare(`SELECT COUNT(*) AS n FROM replica_log WHERE epoch = ?`)
        .get(epoch) as { n: number }
    ).n,
    floor: state.floor,
    heldBySeat,
  };
}
