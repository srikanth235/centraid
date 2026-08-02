// governance: allow-repo-hygiene file-size-limit (#406) trigger generation, cursor reads, and retention share one transactional log invariant
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { REPLICA_SCHEMA_EPOCH } from "../schema/replica.js";
import { listVaultEntities, resolveEntity } from "../schema/tables.js";
import { formatReplicaCursor, parseReplicaCursor } from "./cursor.js";
import type { ReplicaCursor, ReplicaCursorInput } from "./cursor.js";
import { replicaUnavailableColumnsOf } from "./unavailable-columns.js";

export const REPLICA_RETENTION_DAYS = 30;
export const REPLICA_RETENTION_MAX_ENTRIES = 100_000;

export type ReplicaChangeOp = "insert" | "update" | "delete";

export interface ReplicaChangeEntry {
  seq: number;
  epoch: string;
  /** All trigger rows from one committed gateway transaction share this id. */
  commitId: string;
  entity: string;
  rowId: string;
  op: ReplicaChangeOp;
  /** Replica-available OLD row state for exact filtered update/delete projection. */
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
  trigger_schema_version: number;
  active_commit_id: string | null;
  epoch_reason: string;
  epoch_started_at: string;
}

interface EntityTriggerSpec {
  logical: string;
  physical: string;
  primaryKey: string[];
  oldValueColumns: string[];
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function triggerSpecs(vault: DatabaseSync): EntityTriggerSpec[] {
  const specs = listVaultEntities(vault).flatMap((logical) => {
    const ref = resolveEntity(logical, vault);
    if (!ref || ref.file !== "vault") return [];
    // One catalog read per entity supplies both identity and projection
    // columns. This path runs on fresh schema/ext DDL, so avoiding a second
    // PRAGMA per table materially reduces cold vault-open work.
    const columns = vault
      .prepare(`PRAGMA table_info(${JSON.stringify(ref.physical)})`)
      .all() as {
      name: string;
      pk: number;
    }[];
    const excluded = new Set(replicaUnavailableColumnsOf(logical, vault));
    return [
      {
        logical,
        physical: ref.physical,
        primaryKey: columns
          .filter((column) => column.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((column) => column.name),
        oldValueColumns: columns
          .map((column) => column.name)
          .filter((column) => !excluded.has(column)),
      },
    ];
  });
  // Intent outcomes are protocol metadata rather than an app-grantable
  // ontology entity, so they deliberately stay out of schema/tables.ts.
  specs.push({
    logical: "replica.intent",
    physical: "replica_intent_outcome",
    primaryKey: ["intent_id"],
    // Outcomes are device-scoped protocol metadata rather than app data, so
    // the generic vault log never snapshots them.
    oldValueColumns: [],
  });
  return specs;
}

function rowIdExpression(alias: "new" | "old", primaryKey: string[]): string {
  if (primaryKey.length === 0) return `CAST(${alias}.rowid AS TEXT)`;
  const values = primaryKey.map(
    (column) => `${alias}.${quoteIdentifier(column)}`
  );
  return primaryKey.length === 1
    ? `CAST(${values[0]} AS TEXT)`
    : `json_array(${values.join(", ")})`;
}

function oldValuesExpression(spec: EntityTriggerSpec): string {
  if (spec.oldValueColumns.length === 0) return `'{}'`;
  const pairs = spec.oldValueColumns.flatMap((column) => [
    sqlString(column),
    // JSON1 rejects BLOB arguments. Binary cells are intentionally reduced
    // to null; replica filters over BLOB columns fail closed at shape build.
    `CASE WHEN typeof(old.${quoteIdentifier(column)}) = 'blob' THEN NULL ELSE old.${quoteIdentifier(column)} END`,
  ]);
  return `json_object(${pairs.join(", ")})`;
}

function triggerSql(
  spec: EntityTriggerSpec,
  suffix: "ai" | "au" | "ad"
): string {
  const event =
    suffix === "ai" ? "INSERT" : suffix === "au" ? "UPDATE" : "DELETE";
  const name = `trg_replica_${spec.physical}_${suffix}`;
  const changedAt = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
  if (suffix === "au") {
    const oldId = rowIdExpression("old", spec.primaryKey);
    const newId = rowIdExpression("new", spec.primaryKey);
    return `CREATE TRIGGER ${quoteIdentifier(name)} AFTER ${event} ON ${quoteIdentifier(spec.physical)} BEGIN
  INSERT INTO replica_change (epoch, commit_id, entity, row_id, op, old_values_json, changed_at)
  SELECT epoch, COALESCE(active_commit_id, 'implicit:' || lower(hex(randomblob(16)))), ${sqlString(spec.logical)}, ${oldId}, 'delete', ${oldValuesExpression(spec)}, ${changedAt}
    FROM replica_meta WHERE singleton = 1 AND ${oldId} IS NOT ${newId};
  INSERT INTO replica_change (epoch, commit_id, entity, row_id, op, old_values_json, changed_at)
  SELECT epoch, COALESCE(active_commit_id, 'implicit:' || lower(hex(randomblob(16)))), ${sqlString(spec.logical)}, ${newId},
         CASE WHEN ${oldId} IS ${newId} THEN 'update' ELSE 'insert' END,
         CASE WHEN ${oldId} IS ${newId} THEN ${oldValuesExpression(spec)} ELSE NULL END,
         ${changedAt}
    FROM replica_meta WHERE singleton = 1;
END`;
  }
  const op = suffix === "ai" ? "insert" : "delete";
  const alias = suffix === "ai" ? "new" : "old";
  const oldValues = suffix === "ad" ? oldValuesExpression(spec) : "NULL";
  return `CREATE TRIGGER ${quoteIdentifier(name)} AFTER ${event} ON ${quoteIdentifier(spec.physical)} BEGIN
  INSERT INTO replica_change (epoch, commit_id, entity, row_id, op, old_values_json, changed_at)
  SELECT epoch, COALESCE(active_commit_id, 'implicit:' || lower(hex(randomblob(16)))), ${sqlString(spec.logical)}, ${rowIdExpression(alias, spec.primaryKey)}, ${sqlString(op)},
         ${oldValues}, ${changedAt}
    FROM replica_meta WHERE singleton = 1;
END`;
}

function normalizeSql(sql: string): string {
  return sql.replaceAll(/\s+/gu, " ").replace(/;$/u, "").trim();
}

function sqliteSchemaVersion(vault: DatabaseSync): number {
  const row = vault.prepare("PRAGMA schema_version").get() as {
    schema_version: number;
  };
  return row.schema_version;
}

function triggerContractMarker(
  vault: DatabaseSync,
  specs: EntityTriggerSpec[] = triggerSpecs(vault)
): number {
  const contract = specs.flatMap((spec) =>
    (["ai", "au", "ad"] as const).map((suffix) =>
      normalizeSql(triggerSql(spec, suffix))
    )
  );
  const digest = createHash("sha256")
    .update(JSON.stringify([sqliteSchemaVersion(vault), contract]))
    .digest("hex");
  return Number.parseInt(digest.slice(0, 8), 16);
}

/**
 * Install or repair the database-level change triggers for all canonical and
 * currently registered live ext tables. The caller owns transaction scope so
 * ext DDL can install its trigger before the schema transaction commits.
 */
export function refreshReplicaTriggers(vault: DatabaseSync): void {
  const specs = triggerSpecs(vault);
  const existing = new Map(
    (
      vault
        .prepare(
          `SELECT name, sql FROM sqlite_master
            WHERE type = 'trigger' AND name LIKE 'trg_replica_%'`
        )
        .all() as { name: string; sql: string | null }[]
    ).map((row) => [row.name, row.sql] as const)
  );
  const ddl: string[] = [];
  for (const spec of specs) {
    for (const suffix of ["ai", "au", "ad"] as const) {
      const name = `trg_replica_${spec.physical}_${suffix}`;
      const wanted = triggerSql(spec, suffix);
      const current = existing.get(name);
      if (current && normalizeSql(current) === normalizeSql(wanted)) continue;
      if (current !== undefined)
        ddl.push(`DROP TRIGGER ${quoteIdentifier(name)}`);
      ddl.push(wanted);
    }
  }
  // Crossing the JS/native boundary once is substantially cheaper than one
  // exec per trigger on the fresh-vault path; SQLite still applies the batch
  // inside the caller-owned transaction.
  if (ddl.length > 0) vault.exec(ddl.join(";\n"));
  // SQLite increments schema_version for every table/trigger DDL change. A
  // persisted match lets ordinary warm opens skip hundreds of PRAGMA and
  // sqlite_master probes, while any later ext/schema/manual trigger change
  // invalidates the marker and forces this repair pass again.
  vault
    .prepare(
      `UPDATE replica_meta SET trigger_schema_version = ? WHERE singleton = 1`
    )
    .run(triggerContractMarker(vault, specs));
}

function meta(vault: DatabaseSync): MetaRow {
  const row = vault
    .prepare(
      `SELECT epoch, floor_seq, schema_epoch, trigger_schema_version,
              active_commit_id,
              epoch_reason, epoch_started_at
         FROM replica_meta WHERE singleton = 1`
    )
    .get() as MetaRow | undefined;
  if (!row) throw new Error("replica metadata is missing");
  return row;
}

/**
 * Add the commit-group columns to databases created before grouped deltas.
 * The repository is still pre-release, but local vaults are long-lived and
 * must not lose their change history merely because this process learned a
 * stronger paging invariant.
 */
function ensureReplicaCommitColumns(vault: DatabaseSync): void {
  const metaColumns = new Set(
    (
      vault.prepare("PRAGMA table_info(replica_meta)").all() as {
        name: string;
      }[]
    ).map((column) => column.name)
  );
  const changeColumns = new Set(
    (
      vault.prepare("PRAGMA table_info(replica_change)").all() as {
        name: string;
      }[]
    ).map((column) => column.name)
  );
  if (!metaColumns.has("active_commit_id"))
    vault.exec("ALTER TABLE replica_meta ADD COLUMN active_commit_id TEXT");
  if (!changeColumns.has("commit_id")) {
    vault.exec("ALTER TABLE replica_change ADD COLUMN commit_id TEXT");
    vault.exec(
      `UPDATE replica_change
          SET commit_id = 'legacy:' || seq
        WHERE commit_id IS NULL`
    );
  }
  vault.exec(
    `CREATE INDEX IF NOT EXISTS idx_replica_change_epoch_commit_seq
       ON replica_change(epoch, commit_id, seq)`
  );
  const intentTable = vault
    .prepare(
      `SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'replica_intent_outcome'`
    )
    .get() as { sql: string | null } | undefined;
  if (intentTable?.sql && !intentTable.sql.includes("'conflict'")) {
    // The status CHECK constraint is part of the old table definition and
    // SQLite cannot widen CHECK constraints with ALTER TABLE. Rebuild this
    // small protocol table before triggers are refreshed.
    vault.exec(`
      DROP TRIGGER IF EXISTS trg_replica_replica_intent_outcome_ai;
      DROP TRIGGER IF EXISTS trg_replica_replica_intent_outcome_au;
      DROP TRIGGER IF EXISTS trg_replica_replica_intent_outcome_ad;
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
}

export interface ReplicaCommitHandle {
  commitId: string;
  owner: boolean;
}

/** Mark the caller's open SQLite transaction so triggers share one group id. */
export function beginReplicaCommit(vault: DatabaseSync): ReplicaCommitHandle {
  const current = vault
    .prepare(`SELECT active_commit_id FROM replica_meta WHERE singleton = 1`)
    .get() as { active_commit_id: string | null } | undefined;
  if (current?.active_commit_id)
    return { commitId: current.active_commit_id, owner: false };
  const commitId = randomUUID();
  vault
    .prepare(`UPDATE replica_meta SET active_commit_id = ? WHERE singleton = 1`)
    .run(commitId);
  return { commitId, owner: true };
}

/** Clear the transaction marker before the caller commits its write window. */
export function endReplicaCommit(
  vault: DatabaseSync,
  handle: ReplicaCommitHandle
): void {
  if (!handle.owner) return;
  vault
    .prepare(
      `UPDATE replica_meta SET active_commit_id = NULL WHERE singleton = 1`
    )
    .run();
}

function currentSchemaEpoch(vault: DatabaseSync): number {
  // Do not couple replica compatibility to v0's deliberately single-rung
  // vault bootstrap. A build bump invalidates cursors without inventing a
  // compatibility ladder for pre-release replica state.
  void vault;
  return REPLICA_SCHEMA_EPOCH;
}

/** Current epoch, retained floor, and stable high-water position. */
export function currentReplicaLogState(vault: DatabaseSync): ReplicaLogState {
  const row = meta(vault);
  const latest = vault
    .prepare(`SELECT MAX(seq) AS seq FROM replica_change WHERE epoch = ?`)
    .get(row.epoch) as { seq: number | null };
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

/**
 * Initialize the protocol after fresh vault schema bootstrap. A contract change
 * invalidates every derived replica by changing epoch before triggers resume.
 */
export function initializeReplicaProtocol(
  vault: DatabaseSync
): ReplicaLogState {
  ensureReplicaCommitColumns(vault);
  const row = meta(vault);
  const contractChanged = row.schema_epoch !== currentSchemaEpoch(vault);
  if (
    !contractChanged &&
    row.trigger_schema_version === triggerContractMarker(vault)
  ) {
    return currentReplicaLogState(vault);
  }
  // Epoch rotation and the trigger catalog it identifies are one contract
  // change. A crash may expose neither or both, never a new epoch fed by old
  // trigger projection rules.
  vault.exec("BEGIN IMMEDIATE");
  try {
    if (contractChanged) {
      bumpReplicaEpochInTransaction(vault, { reason: "schema-change" });
    }
    refreshReplicaTriggers(vault);
    vault.exec("COMMIT");
  } catch (error) {
    vault.exec("ROLLBACK");
    throw error;
  }
  return currentReplicaLogState(vault);
}

export interface AppendReplicaChangeInput {
  entity: string;
  rowId: string;
  op: ReplicaChangeOp;
  changedAt?: string;
}

/** Append a protocol-only change inside the caller's current transaction. */
export function appendReplicaChange(
  vault: DatabaseSync,
  input: AppendReplicaChangeInput
): ReplicaChangeEntry {
  const changedAt = input.changedAt ?? new Date().toISOString();
  const result = vault
    .prepare(
      `INSERT INTO replica_change (epoch, commit_id, entity, row_id, op, old_values_json, changed_at)
       SELECT epoch, COALESCE(active_commit_id, 'implicit:' || lower(hex(randomblob(16)))), ?, ?, ?, NULL, ? FROM replica_meta WHERE singleton = 1`
    )
    .run(input.entity, input.rowId, input.op, changedAt);
  const seq = Number(result.lastInsertRowid);
  return {
    seq,
    epoch: meta(vault).epoch,
    commitId: (
      vault
        .prepare("SELECT commit_id FROM replica_change WHERE seq = ?")
        .get(seq) as { commit_id: string }
    ).commit_id,
    entity: input.entity,
    rowId: input.rowId,
    op: input.op,
    oldValuesJson: null,
    changedAt,
  };
}

export interface ReadReplicaChangesOptions {
  since?: ReplicaCursorInput;
  limit?: number;
}

/** Read one stable, resumable incremental page. */
export function readReplicaChanges(
  vault: DatabaseSync,
  options: ReadReplicaChangesOptions = {}
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
  const rows = vault
    .prepare(
      `SELECT seq, epoch, commit_id, entity, row_id, op, old_values_json, changed_at
         FROM replica_change
        WHERE epoch = ? AND seq > ? AND seq <= ?
        ORDER BY seq
        LIMIT ?`
    )
    .all(state.epoch, since.seq, state.watermark.seq, limit + 1) as {
    seq: number;
    epoch: string;
    commit_id: string;
    entity: string;
    row_id: string;
    op: ReplicaChangeOp;
    old_values_json: string | null;
    changed_at: string;
  }[];
  let pageRows = rows.length > limit ? rows.slice(0, limit) : rows;
  let last = pageRows.at(-1);
  if (last) {
    const groupTail = vault
      .prepare(
        `SELECT seq, epoch, commit_id, entity, row_id, op, old_values_json, changed_at
           FROM replica_change
          WHERE epoch = ? AND commit_id = ? AND seq > ? AND seq <= ?
          ORDER BY seq`
      )
      .all(state.epoch, last.commit_id, last.seq, state.watermark.seq) as {
      seq: number;
      epoch: string;
      commit_id: string;
      entity: string;
      row_id: string;
      op: ReplicaChangeOp;
      old_values_json: string | null;
      changed_at: string;
    }[];
    if (groupTail.length > 0) pageRows = [...pageRows, ...groupTail];
    last = pageRows.at(-1);
  }
  const hasMore = Boolean(
    last &&
    vault
      .prepare(
        `SELECT 1 AS present FROM replica_change
            WHERE epoch = ? AND seq > ? AND seq <= ? LIMIT 1`
      )
      .get(state.epoch, last.seq, state.watermark.seq)
  );
  const changes = pageRows.map((row) => ({
    seq: row.seq,
    epoch: row.epoch,
    commitId: row.commit_id,
    entity: row.entity,
    rowId: row.row_id,
    op: row.op,
    oldValuesJson: row.old_values_json,
    changedAt: row.changed_at,
  }));
  const lastChange = changes.at(-1);
  const next =
    hasMore && lastChange
      ? { epoch: state.epoch, seq: lastChange.seq }
      : { ...state.watermark };
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

/** Invalidate all cursors (backup restore, schema change, or explicit reset). */
export function bumpReplicaEpoch(
  vault: DatabaseSync,
  options: BumpReplicaEpochOptions
): ReplicaLogState {
  const epoch = options.epoch ?? randomUUID();
  // Validate the same wire restrictions as a cursor before persisting it.
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
  const sequence = vault
    .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'replica_change'`)
    .get() as { seq: number } | undefined;
  const existing = meta(vault);
  const floor = Math.max(existing.floor_seq, sequence?.seq ?? 0);
  vault
    .prepare(
      `UPDATE replica_meta
          SET epoch = ?, floor_seq = ?, schema_epoch = ?, epoch_reason = ?,
              epoch_started_at = ?, updated_at = ?
        WHERE singleton = 1`
    )
    .run(epoch, floor, currentSchemaEpoch(vault), options.reason, now, now);
}

export interface PruneReplicaChangesOptions {
  now?: Date;
  maxAgeMs?: number;
  maxEntries?: number;
}

export interface ReplicaPruneResult {
  expired: number;
  compacted: number;
  overflow: number;
  discardedPriorEpochs: number;
  floor: ReplicaCursor;
  retained: number;
}

function maxSeq(
  vault: DatabaseSync,
  sql: string,
  ...params: (string | number)[]
): number {
  const row = vault.prepare(sql).get(...params) as { seq: number | null };
  return row.seq ?? 0;
}

/** Extend a retention cutoff to the end of the commit group it touches. */
function completeCommitThrough(
  vault: DatabaseSync,
  epoch: string,
  through: number
): number {
  if (through <= 0) return 0;
  const group = vault
    .prepare(
      `SELECT commit_id FROM replica_change
        WHERE epoch = ? AND seq <= ? ORDER BY seq DESC LIMIT 1`
    )
    .get(epoch, through) as { commit_id: string } | undefined;
  if (!group) return 0;
  return maxSeq(
    vault,
    `SELECT MAX(seq) AS seq FROM replica_change
      WHERE epoch = ? AND commit_id = ?`,
    epoch,
    group.commit_id
  );
}

/** Apply the smaller of the age/count windows and advance only across deleted prefixes. */
export function pruneReplicaChanges(
  vault: DatabaseSync,
  options: PruneReplicaChangesOptions = {}
): ReplicaPruneResult {
  const maxAgeMs =
    options.maxAgeMs ?? REPLICA_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
  const maxEntries = options.maxEntries ?? REPLICA_RETENTION_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) {
    throw new RangeError(
      "replica retention maxAgeMs must be a non-negative safe integer"
    );
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    throw new RangeError(
      "replica retention maxEntries must be a non-negative safe integer"
    );
  }
  const cutoff = new Date(
    (options.now ?? new Date()).getTime() - maxAgeMs
  ).toISOString();
  const epoch = meta(vault).epoch;
  let floorCandidate = 0;
  let expired = 0;
  let compacted = 0;
  let overflow = 0;
  let discardedPriorEpochs = 0;
  vault.exec("BEGIN IMMEDIATE");
  try {
    discardedPriorEpochs = Number(
      vault.prepare(`DELETE FROM replica_change WHERE epoch <> ?`).run(epoch)
        .changes
    );

    const ageThrough = completeCommitThrough(
      vault,
      epoch,
      maxSeq(
        vault,
        `SELECT MAX(seq) AS seq FROM replica_change WHERE epoch = ? AND changed_at < ?`,
        epoch,
        cutoff
      )
    );
    if (ageThrough > 0) {
      // Delete the whole prefix, not only timestamp matches: floor cursors
      // may never skip over a retained entry after clock-skewed timestamps.
      expired = Number(
        vault
          .prepare(`DELETE FROM replica_change WHERE epoch = ? AND seq <= ?`)
          .run(epoch, ageThrough).changes
      );
      floorCandidate = Math.max(floorCandidate, ageThrough);
    }

    let count = (
      vault
        .prepare(`SELECT COUNT(*) AS n FROM replica_change WHERE epoch = ?`)
        .get(epoch) as {
        n: number;
      }
    ).n;
    if (count > maxEntries) {
      // Collapse the whole pressured window, not merely the few rows in the
      // FIFO overflow prefix. The maximum superseded sequence is the exact
      // invalidation boundary: a client below it may need an intermediate
      // filtered-membership transition, while a client at/above it has
      // already consumed every entry we remove. Delete the rest of that
      // prefix too because rows at/below the new floor are unreachable after
      // rebootstrap and retaining them would be pure storage waste.
      const compactionCandidate = maxSeq(
        vault,
        `SELECT MAX(older.seq) AS seq
           FROM replica_change older
          WHERE older.epoch = ?
            AND EXISTS (
              SELECT 1 FROM replica_change newer
               WHERE newer.epoch = older.epoch
                 AND newer.entity = older.entity
                 AND newer.row_id = older.row_id
                 AND newer.seq > older.seq
            )`,
        epoch
      );
      const compactionThrough = completeCommitThrough(
        vault,
        epoch,
        compactionCandidate
      );
      if (compactionThrough > 0) {
        compacted = Number(
          vault
            .prepare(
              `DELETE FROM replica_change
                WHERE epoch = ? AND seq <= ?
                  AND EXISTS (
                    SELECT 1 FROM replica_change newer
                     WHERE newer.epoch = replica_change.epoch
                       AND newer.entity = replica_change.entity
                       AND newer.row_id = replica_change.row_id
                       AND newer.seq > replica_change.seq
                  )`
            )
            .run(epoch, compactionThrough).changes
        );
        overflow += Number(
          vault
            .prepare(`DELETE FROM replica_change WHERE epoch = ? AND seq <= ?`)
            .run(epoch, compactionThrough).changes
        );
        floorCandidate = Math.max(floorCandidate, compactionThrough);
        count = (
          vault
            .prepare(`SELECT COUNT(*) AS n FROM replica_change WHERE epoch = ?`)
            .get(epoch) as {
            n: number;
          }
        ).n;
      }

      // Unique-row pressure can remain after latest-per-row compaction. Trim
      // only the residual excess, again advancing across a complete prefix.
      if (count > maxEntries) {
        const excess = count - maxEntries;
        const countCandidate = (
          vault
            .prepare(
              `SELECT seq FROM replica_change WHERE epoch = ? ORDER BY seq LIMIT 1 OFFSET ?`
            )
            .get(epoch, excess - 1) as { seq: number }
        ).seq;
        const countThrough = completeCommitThrough(
          vault,
          epoch,
          countCandidate
        );
        overflow += Number(
          vault
            .prepare(`DELETE FROM replica_change WHERE epoch = ? AND seq <= ?`)
            .run(epoch, countThrough).changes
        );
        floorCandidate = Math.max(floorCandidate, countThrough);
      }
    }

    const existingFloor = meta(vault).floor_seq;
    const floor = Math.max(existingFloor, floorCandidate);
    vault
      .prepare(
        `UPDATE replica_meta SET floor_seq = ?, updated_at = ? WHERE singleton = 1`
      )
      .run(floor, (options.now ?? new Date()).toISOString());
    vault.exec("COMMIT");
  } catch (error) {
    vault.exec("ROLLBACK");
    throw error;
  }
  const state = currentReplicaLogState(vault);
  const retained = (
    vault
      .prepare(`SELECT COUNT(*) AS n FROM replica_change WHERE epoch = ?`)
      .get(epoch) as {
      n: number;
    }
  ).n;
  return {
    expired,
    compacted,
    overflow,
    discardedPriorEpochs,
    floor: state.floor,
    retained,
  };
}
