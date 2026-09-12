// THE FEED'S VIEW OF THE ONE LOG (#1014, R-1014-1).
//
// There used to be two logs. `replica_log` — decoded from the session capture
// the commit bracket below opens — is what a seat tails; `replica_change` was
// a second table, filled by three generated AFTER triggers on every replicated
// table (288 of them on a fresh vault, re-derived on every schema change), and
// read by the doorbell feed the shipped phone subscribes to. Two logs meant
// two sequence spaces, two floors, two retention policies and two answers to
// "what is the version of this row" — and G1, G2, G9 and R6 are all the same
// bug seen from four directions.
//
// So the feed reads `replica_log` too, and what is left here is the mapping
// between the two vocabularies: the log speaks PHYSICAL tables and wire-typed
// row images, the feed speaks LOGICAL entities and the JSON a shape's filter
// runs over. Nothing in this file writes; the capture does that.
//
// THE CURSOR IS THE SAME SHAPE AND A DIFFERENT SPACE. `{epoch, seq}` on the
// wire, unchanged — but a seq that used to index the trigger log now indexes
// `replica_log`. No seat can detect that for itself, so the file says it:
// rung ten rotates the epoch once with reason `one-log`.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { WireValue } from "@centraid/core/protocol";

import { prepared } from "../grant/prepared.js";
import { REPLICA_SCHEMA_EPOCH } from "../schema/replica.js";
import { listVaultEntities, resolveEntity } from "../schema/tables.js";
import { formatReplicaCursor, parseReplicaCursor } from "./cursor.js";
import type { ReplicaCursor, ReplicaCursorInput } from "./cursor.js";
import {
  captureReplicaCommit,
  closeReplicaCapture,
  inReadTransaction,
  openReplicaCapture,
} from "./log.js";
import type { ReplicaCaptureResult } from "./log.js";
import { replicaUnavailableColumnsOf } from "./unavailable-columns.js";

/**
 * The one gateway-private table the feed still names as an entity. Its rows
 * reach the log as `local` doorbell positions (`replica/log.ts`), carrying a
 * key and no image; the gateway resolves which device may read which outcome.
 */
const LOCAL_ENTITY_BY_TABLE: Readonly<Record<string, string>> = {
  replica_intent_outcome: "replica.intent",
};

export type ReplicaChangeOp = "insert" | "update" | "delete";

export interface ReplicaChangeEntry {
  seq: number;
  epoch: string;
  /** The commit position every entry of one transaction shares, as a string. */
  commitId: string;
  entity: string;
  rowId: string;
  op: ReplicaChangeOp;
  /**
   * Replica-available row state BEFORE this change, for exact filtered
   * projection — `null` on an insert (there was no row) and on a doorbell.
   *
   * Reconstructed, not stored: `row_json` overlaid with `prior_json`, which
   * carries the old values of the columns the update changed. An untouched
   * column is the same in both images, so the two together are the whole prior
   * image (#1014, R-1014-13).
   */
  oldValuesJson: string | null;
  changedAt: string;
}

export interface ReplicaLogState {
  epoch: string;
  schemaEpoch: number;
  floor: ReplicaCursor;
  watermark: ReplicaCursor;
  epochReason: string;
  epochStartedAt: string;
}

export interface ReplicaChangePage {
  changes: ReplicaChangeEntry[];
  next: ReplicaCursor;
  watermark: ReplicaCursor;
  floor: ReplicaCursor;
  schemaEpoch: number;
  hasMore: boolean;
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

interface MetaRow {
  epoch: string;
  floor_seq: number;
  schema_epoch: number;
  active_commit_id: string | null;
  epoch_reason: string;
  epoch_started_at: string;
}

function meta(vault: DatabaseSync): MetaRow {
  const row = prepared(
    vault,
    `SELECT epoch, floor_seq, schema_epoch, active_commit_id,
              epoch_reason, epoch_started_at
         FROM replica_meta WHERE singleton = 1`
  ).get() as MetaRow | undefined;
  if (!row) throw new Error("replica metadata is missing");
  return row;
}

/**
 * Keep the intent-outcome table's shape current on a long-lived file.
 *
 * SQLite cannot widen a CHECK with ALTER TABLE, so a status the file's
 * constraint predates needs a rebuild; the additive columns after it are
 * ordinary ALTERs. This is JS rather than a rung because it repairs files
 * frozen at several different shapes, and every statement is idempotent.
 */
function ensureReplicaCommitColumns(vault: DatabaseSync): void {
  const metaColumns = new Set(
    (
      vault.prepare("PRAGMA table_info(replica_meta)").all() as {
        name: string;
      }[]
    ).map((column) => column.name)
  );
  if (!metaColumns.has("active_commit_id"))
    vault.exec("ALTER TABLE replica_meta ADD COLUMN active_commit_id TEXT");
  const intentTable = vault
    .prepare(
      `SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'replica_intent_outcome'`
    )
    .get() as { sql: string | null } | undefined;
  if (intentTable?.sql && !intentTable.sql.includes("'conflict'")) {
    vault.exec(`
      CREATE TABLE replica_intent_outcome_next (
        intent_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('queued','sending','parked','executed','denied','failed','conflict')
        ),
        invocation_id TEXT,
        reason TEXT,
        conflict_json TEXT CHECK (conflict_json IS NULL OR json_valid(conflict_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO replica_intent_outcome_next (
        intent_id, device_id, app_id, action, payload_hash, status,
        invocation_id, reason, conflict_json, created_at, updated_at
      )
      SELECT intent_id, device_id, app_id, action, payload_hash, status,
             invocation_id, reason, NULL, created_at, updated_at
        FROM replica_intent_outcome;
      DROP TABLE replica_intent_outcome;
      ALTER TABLE replica_intent_outcome_next RENAME TO replica_intent_outcome;
      CREATE INDEX IF NOT EXISTS idx_replica_intent_device_status
        ON replica_intent_outcome(device_id, status, updated_at);
    `);
  }
  const intentColumns = new Set(
    (
      vault.prepare("PRAGMA table_info(replica_intent_outcome)").all() as {
        name: string;
      }[]
    ).map((column) => column.name)
  );
  if (!intentColumns.has("conflict_json"))
    vault.exec(
      "ALTER TABLE replica_intent_outcome ADD COLUMN conflict_json TEXT"
    );
  // #929: who a parked write waits on, and the origin row versions its answer
  // stands for. Additive on a file the base DDL already created.
  // The CHECKs come along verbatim: a column added by ALTER whose constraint
  // the baseline states is a file this build could not have created, and the
  // golden-vault gate reads exactly that difference.
  if (!intentColumns.has("waiting_on"))
    vault.exec(
      `ALTER TABLE replica_intent_outcome ADD COLUMN waiting_on
         TEXT CHECK (waiting_on IS NULL OR json_valid(waiting_on))`
    );
  if (!intentColumns.has("answered_versions"))
    vault.exec(
      `ALTER TABLE replica_intent_outcome ADD COLUMN answered_versions
         TEXT CHECK (answered_versions IS NULL OR json_valid(answered_versions))`
    );
}

export interface ReplicaCommitHandle {
  commitId: string;
  owner: boolean;
  /** What produced the commit, carried onto every `replica_log` row. */
  producer?: string;
}

/**
 * Mark the caller's transaction so its rows share one group id — and open the
 * session capture the gateway log is decoded from (#996, R5).
 *
 * THIS PAIR IS THE ONLY CHOKE POINT THERE IS. Every canonical write path
 * already brackets its transaction with `beginReplicaCommit` /
 * `endReplicaCommit`, which is what makes session capture possible at all
 * without a commit hook `node:sqlite` does not expose: the sessions open here,
 * inside the caller's transaction, and are decoded in `endReplicaCommit`,
 * still inside it. A write outside the pair is captured by the next pair's
 * sessions and lands with that commit's position — converging, but attributed
 * to a later producer, which is why the pair is a contract and not a
 * convenience.
 */
export function beginReplicaCommit(
  vault: DatabaseSync,
  options: { producer?: string } = {}
): ReplicaCommitHandle {
  const current = prepared(
    vault,
    `SELECT active_commit_id FROM replica_meta WHERE singleton = 1`
  ).get() as { active_commit_id: string | null } | undefined;
  if (current?.active_commit_id)
    return { commitId: current.active_commit_id, owner: false };
  const commitId = randomUUID();
  prepared(
    vault,
    `UPDATE replica_meta SET active_commit_id = ? WHERE singleton = 1`
  ).run(commitId);
  openReplicaCapture(vault, options.producer ?? "gateway");
  return {
    commitId,
    owner: true,
    ...(options.producer === undefined ? {} : { producer: options.producer }),
  };
}

export function endReplicaCommit(
  vault: DatabaseSync,
  handle: ReplicaCommitHandle
): ReplicaCaptureResult | undefined {
  if (!handle.owner) return undefined;
  // Decode BEFORE the marker clears: the capture reads rows back, and a read
  // is still a statement in this transaction.
  const captured =
    handle.producer === undefined
      ? captureReplicaCommit(vault)
      : captureReplicaCommit(vault, { producer: handle.producer });
  prepared(
    vault,
    `UPDATE replica_meta SET active_commit_id = NULL WHERE singleton = 1`
  ).run();
  return captured;
}

/**
 * Drop the open sessions without decoding — the ROLLBACK path.
 *
 * A rolled-back transaction's changes are undone in the file, but the session
 * that was watching them is not: it still holds them, and the next commit
 * would decode work that never happened. Rollback paths call this.
 */
export function abandonReplicaCommit(vault: DatabaseSync): void {
  closeReplicaCapture(vault);
}

function currentSchemaEpoch(vault: DatabaseSync): number {
  // Deliberately uncoupled from the vault's schema ladder: a build bump
  // invalidates cursors without one.
  void vault;
  return REPLICA_SCHEMA_EPOCH;
}

export function currentReplicaLogState(vault: DatabaseSync): ReplicaLogState {
  const row = meta(vault);
  const latest = prepared(
    vault,
    `SELECT MAX(seq) AS seq FROM replica_log WHERE epoch = ?`
  ).get(row.epoch) as { seq: number | null };
  // ONE FLOOR, FROM THE ONE LOG (#1014, G1/G2). The doorbell lane counts
  // toward the watermark even though the seat door does not serve it: a
  // position has to mean the same thing to every reader of this file.
  const watermarkSeq = Math.max(row.floor_seq, latest.seq ?? 0);
  return {
    epoch: row.epoch,
    schemaEpoch: row.schema_epoch,
    floor: { epoch: row.epoch, seq: row.floor_seq },
    watermark: { epoch: row.epoch, seq: watermarkSeq },
    epochReason: row.epoch_reason,
    epochStartedAt: row.epoch_started_at,
  };
}

/** A contract change rotates the epoch, and nothing else has to be rebuilt. */
export function initializeReplicaProtocol(
  vault: DatabaseSync
): ReplicaLogState {
  ensureReplicaCommitColumns(vault);
  const row = meta(vault);
  if (row.schema_epoch === currentSchemaEpoch(vault))
    return currentReplicaLogState(vault);
  bumpReplicaEpoch(vault, { reason: "schema-change" });
  return currentReplicaLogState(vault);
}

// ---------------------------------------------------------------------------
// THE MAPPING: physical table + wire image → logical entity + filter JSON.

/**
 * Physical table → logical entity, for the entities the registry ENUMERATES.
 *
 * A table with no logical name here is a table the feed has never projected —
 * the audit band resolves but is deliberately not enumerated (#916), and the
 * trigger plane covered exactly this same set because it generated its
 * triggers from the same call. Keyed on `PRAGMA schema_version`, like
 * `replicatedTablesOf`, so an ext band installed mid-session is picked up
 * without inventing a second notion of "the schema moved".
 */
const ENTITY_BY_TABLE = new WeakMap<
  DatabaseSync,
  { schemaVersion: number; entities: Map<string, string> }
>();

function entityByTable(vault: DatabaseSync): Map<string, string> {
  const schemaVersion = (
    prepared(vault, "PRAGMA schema_version").get() as {
      schema_version: number;
    }
  ).schema_version;
  const cached = ENTITY_BY_TABLE.get(vault);
  if (cached && cached.schemaVersion === schemaVersion) return cached.entities;
  const entities = new Map<string, string>(
    Object.entries(LOCAL_ENTITY_BY_TABLE).map(([table, logical]) => [
      table,
      logical,
    ])
  );
  for (const logical of listVaultEntities(vault)) {
    const ref = resolveEntity(logical, vault);
    if (ref) entities.set(ref.physical, logical);
  }
  ENTITY_BY_TABLE.set(vault, { schemaVersion, entities });
  return entities;
}

const UNAVAILABLE_COLUMNS = new WeakMap<
  DatabaseSync,
  { schemaVersion: number; columns: Map<string, ReadonlySet<string>> }
>();

function unavailableColumns(
  vault: DatabaseSync,
  entity: string
): ReadonlySet<string> {
  const schemaVersion = (
    prepared(vault, "PRAGMA schema_version").get() as {
      schema_version: number;
    }
  ).schema_version;
  let cached = UNAVAILABLE_COLUMNS.get(vault);
  if (!cached || cached.schemaVersion !== schemaVersion) {
    cached = { schemaVersion, columns: new Map() };
    UNAVAILABLE_COLUMNS.set(vault, cached);
  }
  let columns = cached.columns.get(entity);
  if (!columns) {
    columns = new Set(replicaUnavailableColumnsOf(entity, vault));
    cached.columns.set(entity, columns);
  }
  return columns;
}

/**
 * One column of a prior image, AS THE TRIGGER'S `json_object` WOULD HAVE
 * WRITTEN IT — because a shape's filter is SQL over this string and has to see
 * the same value it always saw.
 *
 * `row_json` is WIRE-typed (`packages/core/src/protocol`): a 64-bit integer is
 * `{"i":"…"}` and a BLOB is `{"b64":"…"}`. JSON1 could express neither, so a
 * trigger wrote the integer as a number and reduced the BLOB to NULL — and a
 * filter over a binary cell fails closed at shape build either way. The
 * integer is emitted from its decimal text rather than through `Number`, so a
 * rowid past 2^53 stays exact.
 */
function filterScalar(value: WireValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if ("i" in value) return value.i;
  return "null";
}

function filterImageJson(
  image: Record<string, WireValue>,
  excluded: ReadonlySet<string>
): string {
  const pairs: string[] = [];
  for (const [column, value] of Object.entries(image)) {
    if (excluded.has(column)) continue;
    pairs.push(`${JSON.stringify(column)}:${filterScalar(value)}`);
  }
  return `{${pairs.join(",")}}`;
}

/**
 * The row id the feed speaks, from the log's `pk_json`.
 *
 * The two forms are the trigger plane's, kept verbatim so a shape's row-id
 * derivation and every stored opaque id still resolve: a single-column key is
 * its value as text, a composite key is a JSON array in declared key order.
 */
export function replicaRowIdFromKeyJson(pkJson: string): string {
  return rowIdOfKey(JSON.parse(pkJson) as WireValue[]);
}

function rowIdOfKey(key: readonly WireValue[]): string {
  if (key.length === 1) {
    const only = key[0]!;
    if (only === null) return "null";
    if (typeof only === "string") return only;
    if (typeof only === "number") return String(only);
    if (typeof only === "boolean") return only ? "1" : "0";
    if ("i" in only) return only.i;
    return "";
  }
  return `[${key.map((value) => filterScalar(value)).join(",")}]`;
}

// Alias, not interface: only an anonymous shape casts from node:sqlite's
// `Record<string, SQLOutputValue>`.
type LogRow = {
  seq: number;
  commit_seq: number;
  epoch: string;
  table: string;
  op: ReplicaChangeOp;
  pk_json: string;
  row_json: string | null;
  prior_json: string | null;
  committed_at: string;
};

const CHANGE_COLUMNS = `seq, commit_seq, epoch, "table", op, pk_json,
         row_json, prior_json, committed_at`;

function changeEntry(
  vault: DatabaseSync,
  entities: Map<string, string>,
  row: LogRow
): ReplicaChangeEntry | undefined {
  const entity = entities.get(row.table);
  // A table the registry does not enumerate has never been projected; a `ddl`
  // row is the seat's business and not the feed's.
  if (entity === undefined || row.op === ("ddl" as ReplicaChangeOp))
    return undefined;
  const image =
    row.row_json === null
      ? null
      : (JSON.parse(row.row_json) as Record<string, WireValue>);
  let oldValuesJson: string | null = null;
  if (image !== null && row.op !== "insert") {
    const prior =
      row.prior_json === null
        ? image
        : {
            ...image,
            ...(JSON.parse(row.prior_json) as Record<string, WireValue>),
          };
    oldValuesJson = filterImageJson(prior, unavailableColumns(vault, entity));
  }
  return {
    seq: row.seq,
    epoch: row.epoch,
    commitId: String(row.commit_seq),
    entity,
    rowId: rowIdOfKey(JSON.parse(row.pk_json) as WireValue[]),
    op: row.op,
    oldValuesJson,
    changedAt: row.committed_at,
  };
}

export interface ReadReplicaLogPageOptions {
  since?: ReplicaCursorInput;
  limit?: number;
}

/**
 * ONE STABLE VIEW, LIKE THE SEAT LOG'S (#1014, G6). State, rows, the tail of
 * the last commit group and `hasMore` are four statements; a prune of
 * `(since, watermark]` landing between them yielded no changes, `hasMore:
 * false` and `next: watermark`, and the subscriber skipped a span it never
 * received. The bracket is re-entrant: `projectReplicaPage` already runs
 * inside `withReplicaSnapshot`.
 */
export function readReplicaLogPage(
  vault: DatabaseSync,
  options: ReadReplicaLogPageOptions = {}
): ReplicaChangePage {
  return inReadTransaction(vault, () => readReplicaLogPageRows(vault, options));
}

function readReplicaLogPageRows(
  vault: DatabaseSync,
  options: ReadReplicaLogPageOptions = {}
): ReplicaChangePage {
  const state = currentReplicaLogState(vault);
  const since = options.since
    ? parseReplicaCursor(options.since)
    : { ...state.floor };
  if (since.epoch !== state.epoch) {
    throw new ReplicaRebootstrapRequiredError("epoch-mismatch", state);
  }
  if (since.seq < state.floor.seq) {
    throw new ReplicaRebootstrapRequiredError("retention", state);
  }
  if (since.seq > state.watermark.seq) {
    throw new ReplicaRebootstrapRequiredError("cursor-ahead", state);
  }
  const limit = options.limit ?? 1_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new RangeError(
      "replica change page limit must be an integer between 1 and 10000"
    );
  }
  const rows = prepared(
    vault,
    `SELECT ${CHANGE_COLUMNS}
         FROM replica_log
        WHERE epoch = ? AND seq > ? AND seq <= ?
        ORDER BY seq
        LIMIT ?`
  ).all(state.epoch, since.seq, state.watermark.seq, limit + 1) as LogRow[];
  let pageRows = rows.length > limit ? rows.slice(0, limit) : rows;
  let last = pageRows.at(-1);
  if (last) {
    // A page never ends mid-commit: the rest of the last row's transaction
    // comes along whatever the limit says.
    const groupTail = prepared(
      vault,
      `SELECT ${CHANGE_COLUMNS}
           FROM replica_log
          WHERE epoch = ? AND commit_seq = ? AND seq > ? AND seq <= ?
          ORDER BY seq`
    ).all(
      state.epoch,
      last.commit_seq,
      last.seq,
      state.watermark.seq
    ) as LogRow[];
    if (groupTail.length > 0) pageRows = [...pageRows, ...groupTail];
    last = pageRows.at(-1);
  }
  const hasMore = Boolean(
    last &&
    prepared(
      vault,
      `SELECT 1 AS present FROM replica_log
            WHERE epoch = ? AND seq > ? AND seq <= ? LIMIT 1`
    ).get(state.epoch, last.seq, state.watermark.seq)
  );
  const entities = entityByTable(vault);
  const changes = pageRows.flatMap((row) => {
    const entry = changeEntry(vault, entities, row);
    return entry ? [entry] : [];
  });
  // The position, not the projection: a page whose rows all belonged to
  // unprojected tables still ADVANCES, or the feed would re-read them forever.
  const next =
    hasMore && last
      ? { epoch: state.epoch, seq: last.seq }
      : {
          ...state.watermark,
        };
  return {
    changes,
    next,
    watermark: { ...state.watermark },
    floor: { ...state.floor },
    schemaEpoch: state.schemaEpoch,
    hasMore,
  };
}

export interface BumpReplicaEpochOptions {
  reason: string;
  now?: Date;
  epoch?: string;
}

export function bumpReplicaEpoch(
  vault: DatabaseSync,
  options: BumpReplicaEpochOptions
): ReplicaLogState {
  const epoch = options.epoch ?? randomUUID();
  // Reject anything a cursor could not carry, before persisting it.
  formatReplicaCursor({ epoch, seq: 0 });
  const now = (options.now ?? new Date()).toISOString();
  vault.exec("BEGIN IMMEDIATE");
  try {
    bumpReplicaEpochInTransaction(vault, {
      ...options,
      epoch,
      now: new Date(now),
    });
    vault.exec("COMMIT");
  } catch (error) {
    vault.exec("ROLLBACK");
    throw error;
  }
  return currentReplicaLogState(vault);
}

function bumpReplicaEpochInTransaction(
  vault: DatabaseSync,
  options: BumpReplicaEpochOptions
): void {
  const epoch = options.epoch ?? randomUUID();
  formatReplicaCursor({ epoch, seq: 0 });
  const now = (options.now ?? new Date()).toISOString();
  // THE FLOOR COMES FROM THE LOG IT IS A FLOOR OF (#1014, G2). It used to be
  // derived from `sqlite_sequence('replica_change')` — the OTHER log's space —
  // which landed above `MAX(replica_log.seq)` and made `readReplicaLog`
  // default `since = floor`, skip every real row, and report caught-up because
  // `watermark == floor`: seats went silently and permanently stale on every
  // schema change and every backup restore. With one log there is one number
  // and it can only come from one place.
  const logHigh = (
    vault.prepare(`SELECT MAX(seq) AS seq FROM replica_log`).get() as {
      seq: number | null;
    }
  ).seq;
  const existing = vault
    .prepare(`SELECT floor_seq FROM replica_meta WHERE singleton = 1`)
    .get() as { floor_seq: number } | undefined;
  if (!existing) throw new Error("replica metadata is missing");
  const floor = Math.max(existing.floor_seq, logHigh ?? 0);
  vault
    .prepare(
      `UPDATE replica_meta
          SET epoch = ?, floor_seq = ?, schema_epoch = ?,
              epoch_reason = ?, epoch_started_at = ?, updated_at = ?
        WHERE singleton = 1`
    )
    .run(epoch, floor, currentSchemaEpoch(vault), options.reason, now, now);
}
