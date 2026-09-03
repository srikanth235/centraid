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

export const REPLICA_COMPACTION_HELD_ENTITIES: readonly string[] = [
  "access.app",
  "access.app_ext",
  "access.grant",
  "access.grant_scope",
  "access.policy",
];

const REPLICA_COMPACTION_SCAN_CAP = 20_000;
const REPLICA_COMPACTION_SCAN_MARGIN = 1_000;

export type ReplicaChangeOp = "insert" | "update" | "delete";

export interface ReplicaChangeEntry {
  seq: number;
  epoch: string;
  commitId: string;
  entity: string;
  rowId: string;
  op: ReplicaChangeOp;
  oldValuesJson: string | null;
  priorOp: ReplicaChangeOp;
  priorOldValuesJson: string | null;
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
    if (!ref) return [];
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
  specs.push({
    logical: "replica.intent",
    physical: "replica_intent_outcome",
    primaryKey: ["intent_id"],
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
  if (ddl.length > 0) vault.exec(ddl.join(";\n"));
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
  if (!changeColumns.has("prior_op")) {
    vault.exec(
      `ALTER TABLE replica_change ADD COLUMN prior_op TEXT
         CHECK (prior_op IS NULL OR prior_op IN ('insert','update','delete'))`
    );
    vault.exec(
      `ALTER TABLE replica_change ADD COLUMN prior_old_values_json TEXT
         CHECK (prior_old_values_json IS NULL OR json_valid(prior_old_values_json))`
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
  void vault;
  return REPLICA_SCHEMA_EPOCH;
}

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

const CHANGE_COLUMNS = `seq, epoch, commit_id, entity, row_id, op, old_values_json,
         COALESCE(prior_op, op) AS prior_op,
         CASE WHEN prior_op IS NULL THEN old_values_json ELSE prior_old_values_json END
           AS prior_old_values_json,
         changed_at`;

type ChangeRow = {
  seq: number;
  epoch: string;
  commit_id: string;
  entity: string;
  row_id: string;
  op: ReplicaChangeOp;
  old_values_json: string | null;
  prior_op: ReplicaChangeOp;
  prior_old_values_json: string | null;
  changed_at: string;
};

function changeEntry(row: ChangeRow): ReplicaChangeEntry {
  return {
    seq: row.seq,
    epoch: row.epoch,
    commitId: row.commit_id,
    entity: row.entity,
    rowId: row.row_id,
    op: row.op,
    oldValuesJson: row.old_values_json,
    priorOp: row.prior_op,
    priorOldValuesJson: row.prior_old_values_json,
    changedAt: row.changed_at,
  };
}

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
  return changeEntry(
    vault
      .prepare(`SELECT ${CHANGE_COLUMNS} FROM replica_change WHERE seq = ?`)
      .get(seq) as ChangeRow
  );
}

export interface ReadReplicaChangesOptions {
  since?: ReplicaCursorInput;
  limit?: number;
}

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
      `SELECT ${CHANGE_COLUMNS}
         FROM replica_change
        WHERE epoch = ? AND seq > ? AND seq <= ?
        ORDER BY seq
        LIMIT ?`
    )
    .all(state.epoch, since.seq, state.watermark.seq, limit + 1) as ChangeRow[];
  let pageRows = rows.length > limit ? rows.slice(0, limit) : rows;
  let last = pageRows.at(-1);
  if (last) {
    const groupTail = vault
      .prepare(
        `SELECT ${CHANGE_COLUMNS}
           FROM replica_change
          WHERE epoch = ? AND commit_id = ? AND seq > ? AND seq <= ?
          ORDER BY seq`
      )
      .all(
        state.epoch,
        last.commit_id,
        last.seq,
        state.watermark.seq
      ) as ChangeRow[];
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
  const changes = pageRows.map(changeEntry);
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

export function bumpReplicaEpoch(
  vault: DatabaseSync,
  options: BumpReplicaEpochOptions
): ReplicaLogState {
  const epoch = options.epoch ?? randomUUID();
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
  heldEntities?: readonly string[];
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

interface CompactionCandidate {
  seq: number;
  commitId: string;
  key: string;
  entity: string;
  rowId: string;
  op: ReplicaChangeOp;
  oldValuesJson: string | null;
  priorOp: ReplicaChangeOp | null;
  priorOldValuesJson: string | null;
}

interface FoldedPrior {
  entity: string;
  rowId: string;
  op: ReplicaChangeOp;
  oldValuesJson: string | null;
}

function compactSupersededCommits(
  vault: DatabaseSync,
  epoch: string,
  excess: number,
  heldEntities: ReadonlySet<string>
): number {
  const scan = Math.min(
    REPLICA_COMPACTION_SCAN_CAP,
    excess + REPLICA_COMPACTION_SCAN_MARGIN
  );
  const boundary = vault
    .prepare(
      `SELECT seq FROM replica_change WHERE epoch = ? ORDER BY seq LIMIT 1 OFFSET ?`
    )
    .get(epoch, scan - 1) as { seq: number } | undefined;
  const through = boundary
    ? completeCommitThrough(vault, epoch, boundary.seq)
    : maxSeq(
        vault,
        `SELECT MAX(seq) AS seq FROM replica_change WHERE epoch = ?`,
        epoch
      );
  if (through <= 0) return 0;

  const candidates = (
    vault
      .prepare(
        `SELECT seq, commit_id, entity, row_id, op, old_values_json,
                prior_op, prior_old_values_json
           FROM replica_change
          WHERE epoch = ? AND seq <= ?
          ORDER BY seq`
      )
      .all(epoch, through) as {
      seq: number;
      commit_id: string;
      entity: string;
      row_id: string;
      op: ReplicaChangeOp;
      old_values_json: string | null;
      prior_op: ReplicaChangeOp | null;
      prior_old_values_json: string | null;
    }[]
  ).map<CompactionCandidate>((row) => ({
    seq: row.seq,
    commitId: row.commit_id,
    key: `${row.entity}\u0000${row.row_id}`,
    entity: row.entity,
    rowId: row.row_id,
    op: row.op,
    oldValuesJson: row.old_values_json,
    priorOp: row.prior_op,
    priorOldValuesJson: row.prior_old_values_json,
  }));
  if (candidates.length === 0) return 0;

  const latestStmt = vault.prepare(
    `SELECT MAX(seq) AS seq FROM replica_change
      WHERE epoch = ? AND entity = ? AND row_id = ?`
  );
  const latest = new Map<string, number>();
  for (const candidate of candidates) {
    if (latest.has(candidate.key)) continue;
    latest.set(
      candidate.key,
      (
        latestStmt.get(epoch, candidate.entity, candidate.rowId) as {
          seq: number | null;
        }
      ).seq ?? candidate.seq
    );
  }
  const superseded = (candidate: CompactionCandidate): boolean =>
    !heldEntities.has(candidate.entity) &&
    candidate.seq < (latest.get(candidate.key) ?? candidate.seq);

  const groups = new Map<string, CompactionCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.commitId);
    if (group) group.push(candidate);
    else groups.set(candidate.commitId, [candidate]);
  }
  const dropped = new Set<string>();
  for (const [commitId, group] of groups) {
    if (group.every(superseded)) dropped.add(commitId);
  }
  if (dropped.size === 0) return 0;

  const pending = new Map<string, FoldedPrior>();
  const removed: number[] = [];
  const inherit = vault.prepare(
    `UPDATE replica_change
        SET prior_op = ?, prior_old_values_json = ?
      WHERE epoch = ? AND seq = ?`
  );
  const apply = (candidate: CompactionCandidate, prior: FoldedPrior): void => {
    inherit.run(prior.op, prior.oldValuesJson, epoch, candidate.seq);
  };
  for (const candidate of candidates) {
    if (dropped.has(candidate.commitId)) {
      removed.push(candidate.seq);
      const op = candidate.priorOp ?? candidate.op;
      if (op !== "insert" && !pending.has(candidate.key)) {
        pending.set(candidate.key, {
          entity: candidate.entity,
          rowId: candidate.rowId,
          op,
          oldValuesJson:
            candidate.priorOp === null
              ? candidate.oldValuesJson
              : candidate.priorOldValuesJson,
        });
      }
      continue;
    }
    const prior = pending.get(candidate.key);
    if (prior) {
      apply(candidate, prior);
      pending.delete(candidate.key);
    }
  }
  const successor = vault.prepare(
    `SELECT MIN(seq) AS seq FROM replica_change
      WHERE epoch = ? AND entity = ? AND row_id = ? AND seq > ?`
  );
  for (const prior of pending.values()) {
    const seq = (
      successor.get(epoch, prior.entity, prior.rowId, through) as {
        seq: number | null;
      }
    ).seq;
    if (seq === null) continue;
    inherit.run(prior.op, prior.oldValuesJson, epoch, seq);
  }

  const remove = vault.prepare(
    `DELETE FROM replica_change WHERE epoch = ? AND seq BETWEEN ? AND ?`
  );
  let deleted = 0;
  let start = removed[0]!;
  let end = start;
  for (const seq of removed.slice(1)) {
    if (seq === end + 1) {
      end = seq;
      continue;
    }
    deleted += Number(remove.run(epoch, start, end).changes);
    start = seq;
    end = seq;
  }
  deleted += Number(remove.run(epoch, start, end).changes);
  return deleted;
}

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
  const held = new Set(
    options.heldEntities ?? REPLICA_COMPACTION_HELD_ENTITIES
  );
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
      compacted = compactSupersededCommits(
        vault,
        epoch,
        count - maxEntries,
        held
      );
      count -= compacted;

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
        overflow = Number(
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
