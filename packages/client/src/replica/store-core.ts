// governance: allow-repo-hygiene file-size-limit (#419) cohesive driver-neutral SQLite store core; decomposition is outside this issue
import {
  OnlineOnlyError,
  ReplicaProtocolError,
  ReplicaRebootstrapRequiredError,
  ReplicaSearchRefusedError,
} from "./errors.js";
import type { RebootstrapReason } from "./errors.js";
import { applyOptimisticMutations } from "./query.js";
import { censusClass, jsonValue } from "./read-plan-clauses.js";
import {
  assertReplicaOrder,
  assertReplicaPage,
  assertReplicaTieCensus,
  planReplicaRead,
  trimReplicaPage,
} from "./read-plan.js";
import type {
  ReplicaOverlayBinding,
  ReplicaPlannedRow,
  ReplicaReadPlan,
  ReplicaTieCensusRow,
} from "./read-plan.js";
import {
  REPLICA_LOCAL_SEARCH,
  replicaFtsMatchExpression,
  replicaLocalSearchSpec,
  replicaPendingSearchMatch,
  replicaPendingSearchRank,
  replicaSearchRequiredColumns,
  REPLICA_DEFAULT_SEARCH_ROWS,
  REPLICA_MAX_SEARCH_ROWS,
} from "./search.js";
import {
  REPLICA_PROTOCOL_VERSION,
  REPLICA_SYNTHETIC_PRIMARY_KEY,
} from "./types.js";
import type {
  ApplyChangesResult,
  OptimisticMutation,
  ReplicaBootstrapHeader,
  ReplicaChangeBatch,
  ReplicaCoverage,
  ReplicaCursor,
  ReplicaEntitySchema,
  ReplicaInvalidation,
  ReplicaReadRequest,
  ReplicaReadWireResult,
  ReplicaRow,
  ReplicaRowEnvelope,
  ReplicaSearchRequest,
  ReplicaSearchWireResult,
  ReplicaShape,
  ReplicaSnapshot,
  ReplicaSnapshotRow,
  ReplicaDurability,
} from "./types.js";

/** Values the store binds to `?` placeholders: no blobs, no booleans (mapped to 0/1). */
export type ReplicaBindValue = string | number | null;

/**
 * The minimal synchronous SQLite surface the replica store is written over.
 * One adapter wraps `@sqlite.org/sqlite-wasm` (web worker); another wraps
 * `@op-engineering/op-sqlite` (React Native, in-process). Tests substitute a
 * `node:sqlite` adapter to prove the store logic is driver-neutral.
 */
export interface ReplicaSqliteDriver {
  /** Run one parameterized statement (INSERT/UPDATE/DELETE); results discarded. */
  run: (sql: string, bind?: readonly ReplicaBindValue[]) => void;
  /** Run one parameterized query, materializing each row as a plain object. */
  all: <T extends object>(
    sql: string,
    bind?: readonly ReplicaBindValue[]
  ) => T[];
  /** Execute a multi-statement, bindless SQL script (DDL, PRAGMA, tx control). */
  exec: (sql: string) => void;
  /** Release the underlying handle. */
  close: () => void;
  /**
   * Optional open-time capability gate. Called once after the base PRAGMAs and
   * before schema creation so a driver can fail loud (e.g. probe FTS5 on a
   * native build that omitted the extension) instead of throwing opaquely
   * mid-bootstrap.
   */
  assertCapabilities?: () => void;
  /**
   * The `synchronous` level THIS SEAT's storage justifies (ruling
   * SB-replica-sync). The replica is derived, rebootstrappable state whose
   * lost commits are re-pulled from the cursor, so a seat whose outbox lives
   * in a different store — the browser's, in IndexedDB — may run `NORMAL`.
   * A seat whose outbox shares this file must not: it would be trading the
   * member's own queued writes for a page-apply saving.
   *
   * ABSENT MEANS `FULL`. A new driver gets the safe answer without asking.
   */
  synchronous?: "FULL" | "NORMAL";
  /**
   * Run a whole write batch OFF THE JS THREAD, in one transaction (#922 E1).
   *
   * A first-launch bootstrap page and a reconnect's edits are thousands of
   * statements; run synchronously they hold the JS thread for the whole
   * transaction and the app is frozen while they land. A driver that can hand
   * the batch to its own thread (op-sqlite does) implements this, and the
   * store ships the page instead of executing it statement by statement.
   *
   * ABSENT MEANS SYNCHRONOUS. The store falls back to running the same
   * statements itself, so a driver without a background thread still works.
   */
  runBatchAsync?: (statements: readonly ReplicaStatement[]) => Promise<void>;
  /**
   * A driver SHOULD cache prepared statements by SQL text: the store issues a
   * small fixed set of statements and a bootstrap runs them once per row, so
   * re-compiling each time is the difference between three statements per row
   * and thirty.
   */
}

/** One statement of a recorded write batch. */
export interface ReplicaStatement {
  sql: string;
  bind: readonly ReplicaBindValue[];
}

interface MetaRow {
  protocol_version: number;
  vault_id: string;
  cursor_epoch: string;
  cursor_seq: number;
  schema_epoch: string;
}

interface StoredRow {
  row_id: string;
  payload_json: string;
  oversized_json: string;
  server_version: number;
}

interface StoredSchema {
  primary_key: string;
  columns_json: string;
  has_unavailable_fields: number;
}

/**
 * The durable half of a windowed bootstrap. It exists only between
 * `bootstrapBegin` and `bootstrapCommit`, and its presence-without-meta is what
 * makes a half-applied replica unmistakable after a crash: `status().cursor`
 * stays null until commit writes `replica_meta`, so a partial replica can never
 * present itself as complete.
 *
 * It also carries the walk's POSITION, which is what makes an interrupted
 * bootstrap resumable across a process death (#880): `resume_after` is the
 * gateway's opaque continuation token for the next page, and
 * `commit_cursor_*` is page one's cursor — the delta floor the completed walk
 * must still commit at. Both are written in the same transaction as the rows
 * of the page they describe, so a kill between pages loses at most the page
 * that was in flight.
 */
interface StoredBootstrapProgress {
  protocol_version: number;
  vault_id: string;
  schema_epoch: string;
  cursor_epoch: string | null;
  cursor_seq: number | null;
  resume_after: string | null;
  commit_cursor_epoch: string | null;
  commit_cursor_seq: number | null;
  pages_applied: number;
}

interface StoredSearchRow extends StoredRow {
  rank: number;
  snippet: string | null;
}

/** Where an interrupted windowed bootstrap left off. */
export interface ReplicaBootstrapResume {
  /**
   * Continuation token for the next page, or null when every page already
   * landed and only the commit plus its convergence replay remain.
   */
  after: string | null;
  /** Page one's cursor: where the completed walk commits and replays from. */
  commitCursor: ReplicaCursor;
  /** Pages already durably applied — progress reporting only. */
  pages: number;
}

/** One page's durable walk position, recorded with that page's rows. */
export interface ReplicaBootstrapAdvance {
  /** Continuation token for the NEXT page; null once the walk is exhausted. */
  after: string | null;
  /** Page one's cursor. Recorded once — a resumed walk keeps the original. */
  commitCursor: ReplicaCursor;
  /** Pages durably applied including this one. */
  pages: number;
}

/** Live SQLite footprint of one replica database. */
export interface ReplicaStorageBytes {
  pageSize: number;
  pageCount: number;
  /** Pages on the freelist — reclaimable by `PRAGMA incremental_vacuum`. */
  freePages: number;
  bytes: number;
  freeBytes: number;
}

const LOCAL_REPLICA_SCHEMA_VERSION = 8;

/**
 * Rows written into (or removed from) the FTS index between `optimize` runs.
 * FTS5 `optimize` merges every b-tree segment into one — cheap on a small
 * index, minutes on a large one — so it is bounded by this counter rather than
 * run per batch. One bootstrap window is 5,000 rows, so a full 90,000-row walk
 * optimizes about four times on the way plus once at its commit.
 */
const FTS_OPTIMIZE_ROW_INTERVAL = 20_000;

/**
 * Deletions in ONE change batch that make it worth reclaiming freed pages. A
 * fifth of a bootstrap window: far above ordinary sync churn, and squarely in
 * the range a scoped purge or a trimmed era arrives in.
 */
const LARGE_DELETION_BATCH = 1_000;

/**
 * How many ordered columns a replica will index. Eight apps ordering by a
 * handful of columns each sits far below it; past it the store keeps sorting
 * rather than letting an unusual read pattern grow the file.
 */
const ORDER_INDEX_MAX = 64;

/** A stable, SQL-safe identifier for an (entity, column) pair. */
function orderIndexSuffix(key: string): string {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * `replica_row.row_key` is a surrogate INTEGER PRIMARY KEY whose value is also
 * the rowid of that row's `replica_search` entry — the one thing that keeps
 * search-index maintenance logarithmic (#880).
 *
 * FTS5 leaves `shape_id`/`entity`/`row_id` UNINDEXED, so addressing an entry by
 * that triple is a full index scan on every `indexRow`/`deleteRow` — two orders
 * of magnitude on a bootstrap. Addressing by rowid makes each a b-tree lookup.
 *
 * Explicit, not implicit: VACUUM (which {@link ReplicaSqliteStore.reclaimFreePages}
 * runs) renumbers the rowids of a table WITHOUT an INTEGER PRIMARY KEY, which
 * would silently desynchronize the two tables. Declaring `row_key` pins the
 * value for the life of the row. The `(shape_id, entity, row_id)` UNIQUE index
 * serves every lookup, prefix scans included.
 *
 * Rejected alternatives: an external-content FTS5 table (`content=`) is the
 * textbook fix, but its delete protocol requires replaying each entry's original
 * column values, and its content column would have to be the derived search body
 * — a second stored copy of every indexed field. A side mapping table would add
 * a third write per row for a key `replica_row` can carry itself.
 */
const DDL = `
  CREATE TABLE IF NOT EXISTS replica_bootstrap_progress (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    protocol_version INTEGER NOT NULL,
    vault_id TEXT NOT NULL,
    schema_epoch TEXT NOT NULL,
    cursor_epoch TEXT,
    cursor_seq INTEGER,
    resume_after TEXT,
    commit_cursor_epoch TEXT,
    commit_cursor_seq INTEGER,
    pages_applied INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS replica_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    protocol_version INTEGER NOT NULL,
    vault_id TEXT NOT NULL,
    cursor_epoch TEXT NOT NULL,
    cursor_seq INTEGER NOT NULL,
    schema_epoch TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS replica_shape (
    shape_id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS replica_entity_schema (
    shape_id TEXT NOT NULL,
    entity TEXT NOT NULL,
    primary_key TEXT NOT NULL,
    columns_json TEXT NOT NULL,
    has_unavailable_fields INTEGER NOT NULL CHECK (has_unavailable_fields IN (0, 1)),
    PRIMARY KEY (shape_id, entity),
    FOREIGN KEY (shape_id) REFERENCES replica_shape(shape_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS replica_row (
    row_key INTEGER PRIMARY KEY,
    shape_id TEXT NOT NULL,
    entity TEXT NOT NULL,
    row_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    oversized_json TEXT NOT NULL,
    server_version INTEGER NOT NULL DEFAULT 0 CHECK (server_version >= 0),
    UNIQUE (shape_id, entity, row_id),
    FOREIGN KEY (shape_id, entity)
      REFERENCES replica_entity_schema(shape_id, entity) ON DELETE CASCADE
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS replica_search USING fts5(
    shape_id UNINDEXED,
    entity UNINDEXED,
    row_id UNINDEXED,
    body,
    tokenize = "unicode61 remove_diacritics 2"
  );
  CREATE TABLE IF NOT EXISTS replica_search_gap (
    shape_id TEXT NOT NULL,
    entity TEXT NOT NULL,
    row_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    PRIMARY KEY (shape_id, entity, row_id)
  );
`;

/**
 * Resolves a row's search-index rowid inside the statement that needs it — see
 * the note on {@link DDL}. Keeping the lookup in SQL is what makes the rowid
 * discipline free: index maintenance issues the same statements, resolving the
 * rowid through a covering-index probe rather than a whole-index scan. A row
 * this replica does not hold resolves to NULL, which matches nothing.
 */
const SEARCH_ROWID = `(SELECT row_key FROM replica_row
     WHERE shape_id = ? AND entity = ? AND row_id = ?)`;

/**
 * The entire replica store logic, written once over {@link ReplicaSqliteDriver}.
 * Fully synchronous — the async {@link import('./store.js').ReplicaStore}
 * surface is added by the transport-specific wrappers (worker RPC on web, a
 * thin promise wrapper on native).
 */
export class ReplicaSqliteStore {
  /** Rows written into or removed from the FTS index since the last optimize. */
  private indexedSinceOptimize = 0;

  constructor(
    protected readonly driver: ReplicaSqliteDriver,
    private readonly expectedVaultId: string,
    private readonly durability: ReplicaDurability = "durable"
  ) {
    this.driver.exec("PRAGMA foreign_keys=ON;");
    this.driver.exec("PRAGMA journal_mode=DELETE;");
    this.driver.exec(
      `PRAGMA synchronous=${this.driver.synchronous ?? "FULL"};`
    );
    this.driver.assertCapabilities?.();
    this.initializeSchema();
  }

  close(): void {
    this.driver.close();
  }

  status(): {
    cursor: ReplicaCursor | null;
    schemaEpoch: string | null;
    coverage: ReplicaCoverage;
    durability: ReplicaDurability;
  } {
    const meta = this.meta();
    const preview = this.previewMeta();
    const current = meta ?? preview;
    return {
      cursor: current
        ? { epoch: current.cursor_epoch, seq: current.cursor_seq }
        : null,
      schemaEpoch: current?.schema_epoch ?? null,
      coverage: meta ? "complete" : "partial",
      durability: this.durability,
    };
  }

  /** Shape metadata survives reopen and rebuilds the app/entity lookup offline. */
  catalog(): ReplicaShape[] {
    return this.all<{ shape_id: string; app_id: string }>(
      "SELECT shape_id, app_id FROM replica_shape ORDER BY shape_id"
    ).map((shape) => ({
      shapeId: shape.shape_id,
      appId: shape.app_id,
      entities: this.all<StoredSchema & { entity: string }>(
        `SELECT entity, primary_key, columns_json, has_unavailable_fields
           FROM replica_entity_schema WHERE shape_id = ? ORDER BY entity`,
        [shape.shape_id]
      ).map((schema) => ({
        entity: schema.entity,
        primaryKey: schema.primary_key,
        columns: parseStringArray(schema.columns_json, "columns"),
        ...(schema.has_unavailable_fields === 1
          ? { hasUnavailableFields: true }
          : {}),
      })),
    }));
  }

  bootstrap(snapshot: ReplicaSnapshot): ReplicaCursor {
    this.validateSnapshot(snapshot);
    this.transaction(() => {
      this.clear();
      this.writeShapes(snapshot.shapes);
      for (const row of snapshot.rows) this.upsert(row, undefined, true);
      this.writeMeta(snapshot, snapshot.cursor);
    });
    this.reclaimFreePages();
    this.optimizeSearchIndex();
    return snapshot.cursor;
  }

  /**
   * Open a windowed bootstrap. No `replica_meta` row is written, so until
   * {@link bootstrapCommit} the replica reports no cursor — a crash between
   * pages can never leave a partial replica claiming to be complete.
   *
   * Re-opening a bootstrap RESUMES it (#880). An open walk for the same schema
   * epoch that already recorded its page-one cursor keeps its rows, its catalog
   * and its position, and the returned {@link ReplicaBootstrapResume} tells the
   * driver which page to fetch next; the replay-from-page-one invariant is
   * preserved because the ORIGINAL page-one cursor is what comes back. A
   * 90,000-row walk killed by the OS every window would otherwise restart at
   * page one forever. Anything else — a different schema epoch, a walk that
   * never got past its first page, or an explicit `restart` — clears and starts
   * over.
   */
  bootstrapBegin(
    header: ReplicaBootstrapHeader,
    options?: { restart?: boolean }
  ): ReplicaBootstrapResume | undefined {
    this.validateHeader(header);
    const open = this.bootstrapProgress();
    const resumable =
      options?.restart !== true &&
      open !== undefined &&
      open.schema_epoch === header.schemaEpoch &&
      open.commit_cursor_epoch !== null &&
      open.commit_cursor_seq !== null &&
      // The kept catalog must still be the one the rows will be validated
      // against. Same epoch with a different shape set is a grant change, and
      // resuming onto it would fail every page with an unknown shape entity —
      // a wedge, because the stale progress row would outlive each attempt.
      this.sameShapeCatalog(header.shapes);
    if (resumable && open) {
      return {
        after: open.resume_after,
        commitCursor: {
          epoch: open.commit_cursor_epoch as string,
          seq: open.commit_cursor_seq as number,
        },
        pages: open.pages_applied,
      };
    }
    this.transaction(() => {
      this.clear();
      this.writeShapes(header.shapes);
      this.run(
        `INSERT INTO replica_bootstrap_progress
           (singleton, protocol_version, vault_id, schema_epoch)
         VALUES (1, ?, ?, ?)`,
        [header.protocolVersion, header.vaultId, header.schemaEpoch]
      );
    });
    this.reclaimFreePages();
    return undefined;
  }

  /**
   * Apply one window of rows atomically against the open bootstrap's catalog.
   * `advance` records the walk position in the SAME transaction as the rows it
   * describes, which is what makes the resume above exact rather than hopeful.
   */
  bootstrapPage(
    rows: readonly ReplicaSnapshotRow[],
    advance?: ReplicaBootstrapAdvance
  ): void {
    this.transaction(() => this.pageWork(rows, advance));
    this.maybeOptimizeSearchIndex();
  }

  /**
   * The same page, applied OFF THE JS THREAD when the driver can (#922 E1).
   *
   * The page's writes are recorded rather than executed — since #922 C2 a
   * snapshot write issues no reads, so recording captures the whole batch —
   * and handed to the driver's background thread as one transaction. The JS
   * thread is free for the duration instead of frozen for the page.
   *
   * A driver with no background thread runs the synchronous path, so the
   * behaviour is identical either way; only who is blocked differs.
   */
  async bootstrapPageAsync(
    rows: readonly ReplicaSnapshotRow[],
    advance?: ReplicaBootstrapAdvance
  ): Promise<void> {
    const runBatch = this.driver.runBatchAsync;
    if (!runBatch) {
      this.bootstrapPage(rows, advance);
      return;
    }
    const recorded: ReplicaStatement[] = [];
    this.recording = recorded;
    try {
      this.pageWork(rows, advance);
    } finally {
      this.recording = undefined;
    }
    await runBatch.call(this.driver, recorded);
    this.maybeOptimizeSearchIndex();
  }

  private pageWork(
    rows: readonly ReplicaSnapshotRow[],
    advance?: ReplicaBootstrapAdvance
  ): void {
    this.requireBootstrapProgress();
    if (advance) validateCursor(advance.commitCursor);
    {
      for (const row of rows) {
        const schema = this.schema(row.shapeId, row.entity);
        if (!schema) {
          throw new ReplicaProtocolError(
            `Bootstrap row references unknown shape entity ${row.shapeId}/${row.entity}`
          );
        }
        this.validateRow(row, schema);
        // A windowed page is a snapshot write too: its rows come from the walk
        // pinned to page one's cursor, and a resumed page replays the same
        // rows at the same versions (#922 C2).
        this.upsert(row, schema, true);
      }
      if (!advance) return;
      // COALESCE, not assignment: the commit cursor belongs to the walk's FIRST
      // page and a resumed walk must not adopt a newer one — that would skip
      // the deltas the convergence replay exists to apply.
      this.run(
        `UPDATE replica_bootstrap_progress
            SET resume_after = ?,
                pages_applied = ?,
                commit_cursor_epoch = COALESCE(commit_cursor_epoch, ?),
                commit_cursor_seq = COALESCE(commit_cursor_seq, ?)
          WHERE singleton = 1`,
        [
          advance.after,
          advance.pages,
          advance.commitCursor.epoch,
          advance.commitCursor.seq,
        ]
      );
    }
  }

  /**
   * Publish the first window as an explicitly partial preview. `status()` still
   * reports no durable cursor, so a crash restarts bootstrap; reads may paint
   * the newest landed era while lazy backfill continues.
   *
   * Monotonic within an epoch: a partial preview accepts change batches, which
   * advance this same cursor, and a RESUMED walk's page one arrives with a
   * newer-but-not-necessarily-newest cursor. Moving it backwards would make the
   * next feed batch a cursor gap and cost the whole partial replica.
   */
  bootstrapPreview(cursor: ReplicaCursor): void {
    this.requireBootstrapProgress();
    validateCursor(cursor);
    this.run(
      `UPDATE replica_bootstrap_progress
          SET cursor_epoch = ?, cursor_seq = ?
        WHERE singleton = 1
          AND (cursor_epoch IS NULL OR cursor_epoch <> ? OR cursor_seq < ?)`,
      [cursor.epoch, cursor.seq, cursor.epoch, cursor.seq]
    );
  }

  /**
   * Seal the windowed bootstrap at `cursor` — the PAGE-1 cursor, which is the
   * minimum across pages. Later pages were read from their own snapshots, so the
   * caller must replay the change log from this cursor to converge; committing
   * at the minimum is what makes that replay idempotent and complete.
   */
  bootstrapCommit(cursor: ReplicaCursor): ReplicaCursor {
    const progress = this.requireBootstrapProgress();
    validateCursor(cursor);
    this.transaction(() => {
      this.writeMeta(
        {
          protocolVersion:
            progress.protocol_version as typeof REPLICA_PROTOCOL_VERSION,
          vaultId: progress.vault_id,
          schemaEpoch: progress.schema_epoch,
        },
        cursor
      );
      this.run("DELETE FROM replica_bootstrap_progress WHERE singleton = 1");
    });
    // A cold start writes the whole index one window at a time, which leaves
    // FTS5 at its most fragmented exactly when the first search happens.
    this.optimizeSearchIndex();
    return cursor;
  }

  applyChanges(batch: ReplicaChangeBatch): ApplyChangesResult {
    return this.changeWork(batch, (work) => {
      this.transaction(work);
    });
  }

  /**
   * The same batch, applied OFF THE JS THREAD when the driver can (#922 E1).
   *
   * A reconnect's edits are read-then-write per change, so the version guards
   * are hoisted into ONE query for the whole batch first; after that the batch
   * is pure writes and can be recorded and shipped like a bootstrap page.
   */
  async applyChangesAsync(
    batch: ReplicaChangeBatch
  ): Promise<ApplyChangesResult> {
    const runBatch = this.driver.runBatchAsync;
    if (!runBatch) return this.applyChanges(batch);
    this.loadVersions(batch);
    const recorded: ReplicaStatement[] = [];
    let result: ApplyChangesResult;
    try {
      result = this.changeWork(batch, (work) => {
        this.recording = recorded;
        try {
          work();
        } finally {
          this.recording = undefined;
        }
      });
    } finally {
      this.versions = undefined;
    }
    await runBatch.call(this.driver, recorded);
    return result;
  }

  /**
   * Every row version the batch will need, in one query per (shape, entity)
   * instead of one per change. Set for the duration of a batched apply; absent
   * means the guards query as they go.
   */
  private versions: Map<string, number> | undefined;

  private loadVersions(batch: ReplicaChangeBatch): void {
    const byEntity = new Map<
      string,
      { shapeId: string; entity: string; rowIds: string[] }
    >();
    for (const change of batch.changes) {
      const key = `${change.shapeId}\u0000${change.entity}`;
      const bucket = byEntity.get(key) ?? {
        shapeId: change.shapeId,
        entity: change.entity,
        rowIds: [],
      };
      bucket.rowIds.push(change.rowId);
      byEntity.set(key, bucket);
    }
    const versions = new Map<string, number>();
    for (const bucket of byEntity.values()) {
      const rows = this.all<{ row_id: string; server_version: number }>(
        `SELECT row_id, server_version FROM replica_row
          WHERE shape_id = ? AND entity = ?
            AND row_id IN (SELECT value FROM json_each(?))`,
        [
          bucket.shapeId,
          bucket.entity,
          JSON.stringify([...new Set(bucket.rowIds)]),
        ]
      );
      for (const row of rows) {
        versions.set(
          `${bucket.shapeId}\u0000${bucket.entity}\u0000${row.row_id}`,
          row.server_version
        );
      }
    }
    this.versions = versions;
  }

  private storedVersion(
    shapeId: string,
    entity: string,
    rowId: string
  ): { server_version: number } | undefined {
    if (this.versions) {
      const known = this.versions.get(
        `${shapeId}\u0000${entity}\u0000${rowId}`
      );
      return known === undefined ? undefined : { server_version: known };
    }
    return this.one<{ server_version: number }>(
      `SELECT server_version FROM replica_row
        WHERE shape_id = ? AND entity = ? AND row_id = ?`,
      [shapeId, entity, rowId]
    );
  }

  private changeWork(
    batch: ReplicaChangeBatch,
    runTransaction: (work: () => void) => void
  ): ApplyChangesResult {
    const completeMeta = this.meta();
    const meta = completeMeta ?? this.previewMeta();
    if (!meta) throw new ReplicaRebootstrapRequiredError("not-bootstrapped");
    validateCursor(batch.from);
    validateCursor(batch.to);
    const mismatch = this.changeMismatch(meta, batch);
    if (mismatch) {
      this.wipe();
      throw new ReplicaRebootstrapRequiredError(mismatch);
    }
    // Spent: the whole batch is at or behind the stored cursor, so it carries
    // nothing this replica has not applied. Re-applying would be harmless but
    // moving the cursor BACK to `batch.to` would not — the checkpoint it posts
    // must stay monotonic, and the next pull must not re-ask for changes this
    // store already holds.
    if (batch.to.seq <= meta.cursor_seq) {
      return {
        cursor: { epoch: meta.cursor_epoch, seq: meta.cursor_seq },
        invalidations: [],
        outcomes: batch.outcomes ?? [],
      };
    }

    const invalidations: ReplicaInvalidation[] = [];
    runTransaction(() => {
      for (const change of batch.changes) {
        const schema = this.schema(change.shapeId, change.entity);
        if (!schema) {
          throw new ReplicaProtocolError(
            `Change references unknown shape entity ${change.shapeId}/${change.entity}`
          );
        }
        if (change.op === "delete") {
          this.deleteRow(
            change.shapeId,
            change.entity,
            change.rowId,
            change.rowVersion
          );
        } else {
          this.validateRow(change, schema);
          this.upsert(change, schema);
        }
        invalidations.push({
          shapeId: change.shapeId,
          entity: change.entity,
          rowId: change.rowId,
          source: "canonical",
        });
      }
      if (completeMeta) {
        this.run(
          "UPDATE replica_meta SET cursor_epoch = ?, cursor_seq = ? WHERE singleton = 1",
          [batch.to.epoch, batch.to.seq]
        );
      } else {
        this.run(
          `UPDATE replica_bootstrap_progress
              SET cursor_epoch = ?, cursor_seq = ? WHERE singleton = 1`,
          [batch.to.epoch, batch.to.seq]
        );
      }
    });
    this.maybeOptimizeSearchIndex();
    // A batch this deletion-heavy is a scoped purge arriving as deltas (an app
    // grant withdrawn, an era trimmed), not ordinary churn: hand its pages back
    // rather than leaving a phone that just freed rows no freer on disk.
    if (
      batch.changes.filter((change) => change.op === "delete").length >=
      LARGE_DELETION_BATCH
    ) {
      this.reclaimFreePages();
    }
    return {
      cursor: batch.to,
      invalidations: dedupeInvalidations(invalidations),
      outcomes: batch.outcomes ?? [],
    };
  }

  read(
    request: ReplicaReadRequest,
    mutations: OptimisticMutation[] = [],
    now: Date = new Date()
  ): ReplicaReadWireResult {
    const completeMeta = this.meta();
    const meta = completeMeta ?? this.previewMeta();
    if (!meta) throw new ReplicaRebootstrapRequiredError("not-bootstrapped");
    const schema = this.schema(request.shapeId, request.entity);
    if (!schema) {
      throw new ReplicaProtocolError(
        `Shape does not contain entity ${request.shapeId}/${request.entity}`
      );
    }
    const relevant = mutations.filter(
      (mutation) =>
        mutation.shapeId === request.shapeId &&
        mutation.entity === request.entity
    );
    // ONE statement filters, orders and limits, and only the returned page is
    // parsed. No scan-the-entity fallback: a plan the grammar cannot express
    // escalates online (#883).
    const plan = planReplicaRead(
      schema,
      request,
      now,
      this.overlay(request, schema, relevant)
    );
    // The ordering index makes the paging statement a range scan of `limit`
    // rows instead of a sort of the whole entity (#922 C3).
    this.ensureOrderIndex(request.entity, plan);
    const probed = this.all<ReplicaPlannedRow>(plan.sql, plan.binds);
    assertReplicaPage(probed, plan);
    if (plan.orderCensus && probed.length > 0) {
      assertReplicaOrder(this.cachedCensus(plan.orderCensus), plan);
    }
    // The plan over-fetches by one row; that probe is dropped HERE and reported
    // as `truncated`, never swallowed (#922 0a).
    const page = trimReplicaPage(probed, plan);
    const planned = page.rows;
    if (plan.tieCensus) {
      const census = this.cachedCensus<ReplicaTieCensusRow>(plan.tieCensus);
      if (census) assertReplicaTieCensus(census);
    }
    // Confined only when a pk-eq read found its row; anything wider, or a miss,
    // stays entity-wide — which is what an absent rowId means (#883).
    const confinedRowId =
      request.where?.length === 1 &&
      request.where[0]?.op === "eq" &&
      request.where[0]?.column === schema.primaryKey &&
      planned.length === 1
        ? planned[0]?.row_id
        : undefined;
    return {
      rows: planned.map((row) => this.envelope(row, schema)),
      cursor: { epoch: meta.cursor_epoch, seq: meta.cursor_seq },
      dependency: {
        shapeId: request.shapeId,
        entity: request.entity,
        ...(confinedRowId === undefined ? {} : { rowId: confinedRowId }),
      },
      coverage: completeMeta ? "complete" : "partial",
      ...(page.truncated ? { truncated: true, appliedLimit: plan.limit } : {}),
    };
  }

  /**
   * Compose the outbox's optimistic effects for the rows they address, so the
   * plan reads the overlaid set rather than the stored one. Bounded by the
   * MUTATIONS, not the entity: three pending edits cost three rows however
   * large the library.
   */
  private overlay(
    request: ReplicaReadRequest,
    schema: ReplicaEntitySchema,
    relevant: readonly OptimisticMutation[]
  ): ReplicaOverlayBinding | undefined {
    if (relevant.length === 0) return undefined;
    const rowIds = [...new Set(relevant.map((mutation) => mutation.rowId))];
    const addressed = this.all<StoredRow>(
      `SELECT row_id, payload_json, oversized_json, server_version
         FROM replica_row
        WHERE shape_id = ? AND entity = ?
          AND row_id IN (SELECT value FROM json_each(?))`,
      [request.shapeId, request.entity, JSON.stringify(rowIds)]
    ).map((row) => this.envelope(row, schema));
    return {
      rowIds: JSON.stringify(rowIds),
      rows: JSON.stringify(
        applyOptimisticMutations([...addressed], [...relevant], schema).map(
          (row) => ({
            i: row.rowId,
            p: JSON.stringify(row.values),
            o: JSON.stringify(row.oversizedFields),
            v: row.rowVersion ?? 0,
          })
        )
      ),
    };
  }

  private envelope(
    row: StoredRow,
    schema: ReplicaEntitySchema
  ): ReplicaRowEnvelope {
    return {
      rowId: row.row_id,
      values: JSON.parse(row.payload_json) as ReplicaRow,
      oversizedFields: parseStringArray(row.oversized_json, "oversized fields"),
      hasUnavailableFields: schema.hasUnavailableFields === true,
      ...(row.server_version > 0 ? { rowVersion: row.server_version } : {}),
    };
  }

  /**
   * FTS-backed local search over eager replica metadata. A feature that could
   * produce an incomplete or differently-ranked answer fails online-only.
   */
  search(
    request: ReplicaSearchRequest,
    mutations: OptimisticMutation[] = []
  ): ReplicaSearchWireResult {
    const completeMeta = this.meta();
    const meta = completeMeta ?? this.previewMeta();
    if (!meta) throw new ReplicaRebootstrapRequiredError("not-bootstrapped");
    const schema = this.schema(request.shapeId, request.entity);
    if (!schema) {
      throw new ReplicaProtocolError(
        `Shape does not contain entity ${request.shapeId}/${request.entity}`
      );
    }
    if (schema.hasUnavailableFields) {
      throw new ReplicaSearchRefusedError(
        `${request.entity} has fields withheld by this scope`
      );
    }
    const spec = replicaLocalSearchSpec(request.entity);
    const required = replicaSearchRequiredColumns(spec);
    const missing = required.filter(
      (column) => !schema.columns.includes(column)
    );
    if (missing.length > 0) {
      throw new OnlineOnlyError(
        `replica shape does not expose indexed column(s) ${missing.join(", ")}`
      );
    }
    if ((request.where?.length ?? 0) > 0) {
      throw new OnlineOnlyError(
        "filtered search requires canonical SQLite consent predicates"
      );
    }
    const gap = this.one<{ reason: string }>(
      `SELECT reason FROM replica_search_gap
        WHERE shape_id = ? AND entity = ? LIMIT 1`,
      [request.shapeId, request.entity]
    );
    if (gap)
      throw new OnlineOnlyError(
        `replica search index is incomplete: ${gap.reason}`
      );

    const match = replicaFtsMatchExpression(request.query);
    const requestedLimit = request.limit ?? REPLICA_DEFAULT_SEARCH_ROWS;
    if (!Number.isSafeInteger(requestedLimit)) {
      throw new ReplicaProtocolError("Search limit must be a safe integer");
    }
    const limit = Math.min(
      Math.max(requestedLimit, 1),
      REPLICA_MAX_SEARCH_ROWS
    );
    const relevant = mutations.filter(
      (mutation) =>
        mutation.shapeId === request.shapeId &&
        mutation.entity === request.entity
    );
    const indexed = new Set(required);
    const indexedUpserts = relevant.filter(
      (mutation) =>
        mutation.op === "upsert" &&
        Object.keys(mutation.values).some((column) => indexed.has(column))
    );
    const indexedRowIds = new Set(indexedUpserts.map((entry) => entry.rowId));
    // Any overlay can remove a canonical hit or add a provisional one. Pull a
    // bounded replacement per mutation so the final page still fills its
    // requested limit after local composition.
    const hasOpaqueIdentity =
      schema.primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY;
    // `+ 1` is the truncation probe, on the same rule as the read plan (#922
    // 0a): a page of exactly `limit` hits proves nothing, one hit past the
    // window proves the window cut the answer short. The `relevant.length`
    // term already covers overlay-removed hits, so the probe survives them.
    const fetchLimit =
      limit + 1 + relevant.length + (hasOpaqueIdentity ? 1 : 0);
    if (fetchLimit > 10_000) {
      throw new OnlineOnlyError(
        "the pending search overlay exceeds the local bounded work limit"
      );
    }
    const tieOrder = hasOpaqueIdentity ? "" : ", replica_search.row_id";
    const rows = this.all<StoredSearchRow>(
      `SELECT replica_search.row_id, replica_row.payload_json,
              replica_row.oversized_json, replica_row.server_version,
              replica_search.rank AS rank,
              snippet(replica_search, -1, '⟦', '⟧', '…', 12) AS snippet
         FROM replica_search
         JOIN replica_row ON replica_row.row_key = replica_search.rowid
        WHERE replica_search MATCH ?
          AND replica_search.shape_id = ? AND replica_search.entity = ?
        ORDER BY replica_search.rank${tieOrder}
        LIMIT ?`,
      [match, request.shapeId, request.entity, fetchLimit]
    ).map((row) => ({
      rowId: row.row_id,
      values: {
        ...(JSON.parse(row.payload_json) as ReplicaRow),
        _rank: row.rank,
        _snippet: row.snippet ?? "",
      },
      oversizedFields: parseStringArray(row.oversized_json, "oversized fields"),
      hasUnavailableFields: schema.hasUnavailableFields === true,
      ...(row.server_version > 0 ? { rowVersion: row.server_version } : {}),
    }));
    const canonicalHitIds = new Set(rows.map((row) => row.rowId));
    // Indexed edits/adds may not be present in canonical FTS. Read only their
    // addressed canonical rows, then apply the same mutation stream used by
    // ordinary reads. New rows begin from the mutation itself.
    const addressed: StoredRow[] = [];
    const addressedIds = [...indexedRowIds].filter(
      (rowId) => !canonicalHitIds.has(rowId)
    );
    for (let offset = 0; offset < addressedIds.length; offset += 400) {
      const chunk = addressedIds.slice(offset, offset + 400);
      addressed.push(
        ...this.all<StoredRow>(
          `SELECT row_id, payload_json, oversized_json, server_version
             FROM replica_row
            WHERE shape_id = ? AND entity = ?
              AND row_id IN (${chunk.map(() => "?").join(", ")})`,
          [request.shapeId, request.entity, ...chunk]
        )
      );
    }
    const candidates = [
      ...rows,
      ...addressed.map((row) => this.envelope(row, schema)),
    ];
    const overlaid = applyOptimisticMutations(candidates, relevant, schema)
      .flatMap((row, index) => {
        if (!indexedRowIds.has(row.rowId))
          return canonicalHitIds.has(row.rowId) ? [row] : [];
        const local = replicaPendingSearchMatch(
          row.values,
          spec,
          request.query
        );
        if (!local.matches) return [];
        return [
          {
            ...row,
            values: {
              ...row.values,
              _rank: replicaPendingSearchRank(index),
              _snippet: local.snippet,
            },
          },
        ];
      })
      .sort(
        (left, right) =>
          Number(left.values._rank ?? 0) - Number(right.values._rank ?? 0) ||
          String(left.values[schema.primaryKey] ?? left.rowId).localeCompare(
            String(right.values[schema.primaryKey] ?? right.rowId)
          )
      );
    if (!hasOpaqueIdentity) {
      const nonTextPrimary = overlaid.find(
        (row) => typeof row.values[schema.primaryKey] !== "string"
      );
      if (nonTextPrimary) {
        throw new OnlineOnlyError(
          "non-text primary-key ties require canonical SQLite affinity ordering"
        );
      }
    } else if (
      overlaid.length > limit &&
      overlaid[limit - 1]?.values._rank === overlaid[limit]?.values._rank
    ) {
      throw new OnlineOnlyError(
        "an equal-rank LIMIT boundary requires the undisclosed canonical primary key"
      );
    }
    return {
      rows: overlaid.slice(0, limit),
      cursor: { epoch: meta.cursor_epoch, seq: meta.cursor_seq },
      dependency: { shapeId: request.shapeId, entity: request.entity },
      coverage: completeMeta ? "complete" : "partial",
      ...(overlaid.length > limit
        ? { truncated: true, appliedLimit: limit }
        : {}),
    };
  }

  wipe(): void {
    this.transaction(() => this.clear());
    this.reclaimFreePages();
  }

  /**
   * Live SQLite footprint, for the Phone storage screen's per-vault database
   * total. `dbstat` is a compile-time option op-sqlite does not ship, so this
   * is the page arithmetic every build has: `freeBytes` is what a
   * {@link reclaimFreePages} pass would hand back to the filesystem.
   */
  storageBytes(): ReplicaStorageBytes {
    const pageSize = this.pragmaNumber("page_size");
    const pageCount = this.pragmaNumber("page_count");
    const freePages = this.pragmaNumber("freelist_count");
    return {
      pageSize,
      pageCount,
      freePages,
      bytes: pageSize * pageCount,
      freeBytes: pageSize * freePages,
    };
  }

  private writeShapes(shapes: readonly ReplicaShape[]): void {
    this.schemas.clear();
    for (const shape of shapes) {
      this.run("INSERT INTO replica_shape(shape_id, app_id) VALUES (?, ?)", [
        shape.shapeId,
        shape.appId,
      ]);
      for (const schema of shape.entities) {
        this.run(
          `INSERT INTO replica_entity_schema
             (shape_id, entity, primary_key, columns_json, has_unavailable_fields)
           VALUES (?, ?, ?, ?, ?)`,
          [
            shape.shapeId,
            schema.entity,
            schema.primaryKey,
            JSON.stringify(schema.columns),
            schema.hasUnavailableFields ? 1 : 0,
          ]
        );
      }
    }
  }

  private writeMeta(
    header: Omit<ReplicaBootstrapHeader, "shapes">,
    cursor: ReplicaCursor
  ): void {
    this.run(
      `INSERT INTO replica_meta
         (singleton, protocol_version, vault_id, cursor_epoch, cursor_seq, schema_epoch)
       VALUES (1, ?, ?, ?, ?, ?)`,
      [
        header.protocolVersion,
        header.vaultId,
        cursor.epoch,
        cursor.seq,
        header.schemaEpoch,
      ]
    );
  }

  private sameShapeCatalog(shapes: readonly ReplicaShape[]): boolean {
    const stored = this.all<{ shape_id: string }>(
      "SELECT shape_id FROM replica_shape ORDER BY shape_id"
    ).map((row) => row.shape_id);
    const incoming = shapes.map((shape) => shape.shapeId).sort();
    return (
      stored.length === incoming.length &&
      stored.every((shapeId, index) => shapeId === incoming[index])
    );
  }

  private bootstrapProgress(): StoredBootstrapProgress | undefined {
    return this.one<StoredBootstrapProgress>(
      `SELECT protocol_version, vault_id, schema_epoch, cursor_epoch, cursor_seq,
              resume_after, commit_cursor_epoch, commit_cursor_seq, pages_applied
         FROM replica_bootstrap_progress WHERE singleton = 1`
    );
  }

  private requireBootstrapProgress(): StoredBootstrapProgress {
    const progress = this.bootstrapProgress();
    if (!progress) {
      throw new ReplicaProtocolError("No replica bootstrap is open");
    }
    return progress;
  }

  private clear(): void {
    this.schemas.clear();
    this.invalidateCensuses();
    this.driver.exec(`
      DELETE FROM replica_bootstrap_progress;
      DELETE FROM replica_search;
      DELETE FROM replica_search_gap;
      DELETE FROM replica_row;
      DELETE FROM replica_entity_schema;
      DELETE FROM replica_shape;
      DELETE FROM replica_meta;
    `);
  }

  /**
   * The local replica is disposable derived state. During v0 development an
   * incompatible schema is rebuilt in place instead of being migrated.
   */
  private initializeSchema(): void {
    const version =
      this.one<{ user_version: number }>("PRAGMA user_version")?.user_version ??
      0;
    if (version === LOCAL_REPLICA_SCHEMA_VERSION) {
      this.driver.exec(DDL);
      return;
    }

    this.transaction(() => {
      this.driver.exec(`
        DROP TABLE IF EXISTS replica_bootstrap_progress;
        DROP TABLE IF EXISTS replica_search;
        DROP TABLE IF EXISTS replica_search_gap;
        DROP TABLE IF EXISTS replica_row;
        DROP TABLE IF EXISTS replica_entity_schema;
        DROP TABLE IF EXISTS replica_shape;
        DROP TABLE IF EXISTS replica_meta;
      `);
      this.driver.exec(DDL);
      this.driver.exec(
        `PRAGMA user_version = ${LOCAL_REPLICA_SCHEMA_VERSION};`
      );
    });
    this.enableIncrementalVacuum();
  }

  /**
   * SQLite accepts `auto_vacuum` only on an empty database or through a full
   * VACUUM, and a replica that keeps the default NONE never returns a purged
   * era's pages to the filesystem. The schema rebuild above is the one cheap
   * moment to flip it: every replica table has just been dropped, so the VACUUM
   * that applies the mode rewrites an almost-empty file.
   *
   * Best effort by design. VACUUM needs an exclusive lock and this file is read
   * through a second op-sqlite handle under `journal_mode=DELETE`; a busy
   * database leaves the mode at NONE rather than failing to open. Journal mode
   * is NOT touched here (see `op-sqlite-driver.ts`).
   */
  private enableIncrementalVacuum(): void {
    try {
      this.driver.exec("PRAGMA auto_vacuum=INCREMENTAL;");
      this.driver.exec("VACUUM;");
    } catch {
      /* Shrinking is an optimization; the replica opens either way. */
    }
  }

  /**
   * Hand a large deletion's pages back after `clear()` or a scoped purge.
   *
   * `PRAGMA incremental_vacuum` yields ONE ROW PER FREED PAGE, so a driver that
   * materializes rows (op-sqlite, node:sqlite) reclaims the whole freelist in
   * one call while sqlite-wasm's `exec` stops after the first. Hence the check
   * and the VACUUM fallback: it is portable, and right after a purge it rewrites
   * an almost-empty file. A database whose `auto_vacuum` flip never took has no
   * reclaimable freelist and falls out at the first test.
   */
  private reclaimFreePages(): void {
    try {
      if (this.pragmaNumber("freelist_count") === 0) return;
      this.all("PRAGMA incremental_vacuum");
      if (this.pragmaNumber("freelist_count") === 0) return;
      this.driver.exec("VACUUM;");
    } catch {
      /* See enableIncrementalVacuum: reclaiming space is never load-bearing. */
    }
  }

  /** Bounded FTS5 merge; see {@link FTS_OPTIMIZE_ROW_INTERVAL}. */
  private maybeOptimizeSearchIndex(): void {
    if (this.indexedSinceOptimize < FTS_OPTIMIZE_ROW_INTERVAL) return;
    this.optimizeSearchIndex();
  }

  private optimizeSearchIndex(): void {
    this.indexedSinceOptimize = 0;
    try {
      this.run("INSERT INTO replica_search(replica_search) VALUES('optimize')");
    } catch {
      /* A merge that could not run leaves a correct, merely slower, index. */
    }
  }

  private pragmaNumber(pragma: string): number {
    const row = this.one<Record<string, unknown>>(`PRAGMA ${pragma}`);
    const value = row ? Object.values(row)[0] : undefined;
    return typeof value === "number" ? value : 0;
  }

  private meta(): MetaRow | undefined {
    return this.one<MetaRow>("SELECT * FROM replica_meta WHERE singleton = 1");
  }

  private previewMeta(): MetaRow | undefined {
    const row = this.one<StoredBootstrapProgress>(
      `SELECT protocol_version, vault_id, schema_epoch, cursor_epoch, cursor_seq
         FROM replica_bootstrap_progress WHERE singleton = 1`
    );
    if (!row || row.cursor_epoch === null || row.cursor_seq === null)
      return undefined;
    return {
      protocol_version: row.protocol_version,
      vault_id: row.vault_id,
      schema_epoch: row.schema_epoch,
      cursor_epoch: row.cursor_epoch,
      cursor_seq: row.cursor_seq,
    };
  }

  /**
   * The catalog is written once per bootstrap and never per row, so looking a
   * schema up per row was a query the answer of which could not have changed
   * (#922 E1). Cleared wherever the catalog is.
   */
  private readonly schemas = new Map<string, ReplicaEntitySchema | undefined>();

  private schema(
    shapeId: string,
    entity: string
  ): ReplicaEntitySchema | undefined {
    const key = `${shapeId}\u0000${entity}`;
    if (this.schemas.has(key)) return this.schemas.get(key);
    const resolved = this.readSchema(shapeId, entity);
    this.schemas.set(key, resolved);
    return resolved;
  }

  private readSchema(
    shapeId: string,
    entity: string
  ): ReplicaEntitySchema | undefined {
    const row = this.one<StoredSchema>(
      `SELECT primary_key, columns_json, has_unavailable_fields
         FROM replica_entity_schema WHERE shape_id = ? AND entity = ?`,
      [shapeId, entity]
    );
    if (!row) return undefined;
    return {
      entity,
      primaryKey: row.primary_key,
      columns: parseStringArray(row.columns_json, "columns"),
      ...(row.has_unavailable_fields === 1
        ? { hasUnavailableFields: true }
        : {}),
    };
  }

  /**
   * `fromSnapshot` marks a BOOTSTRAP write, where the snapshot is the whole
   * truth: the tables were cleared (or the page is being replayed from the
   * same pinned cursor), so the version guard cannot fire and the two
   * clean-up deletes have nothing to clean. Skipping them takes a bootstrap
   * from five statements a row to two (#922 C2). On the incremental path they
   * all still run — there a row's previous state is real.
   */
  /**
   * An expression index over the ordered column, created the first time a read
   * asks for that order (#922 C3).
   *
   * Ordering is `json_extract(payload_json, '$.col')`, which no ordinary index
   * can serve, so an ordered read sorted the whole entity — 50k rows to return
   * fifty. The index must spell the expression EXACTLY as the plan does, hence
   * `jsonValue`, and it carries `shape_id, entity` first so one index serves
   * every shape.
   *
   * Bounded by the columns reads actually order by, and capped: past the cap
   * the read falls back to the sort rather than growing the file without
   * limit. Names are derived from the entity and column, never from the wire —
   * both are checked against the shape catalog before a plan is built.
   */
  private readonly orderIndexes = new Set<string>();

  /**
   * Both censuses' verdicts, cached until the next write (#922 C3, #922 E3).
   *
   * A census asks a question about the STORED VALUES — is any of them
   * oversized, non-scalar, straddling text and number, or carried by two rows
   * at once? — so its answer changes only when rows change, never between two
   * reads. Computing one per read made every ordered read O(entity) even with
   * the ordering index doing the paging in O(limit). `invalidateCensuses` runs
   * on every write path.
   */
  private readonly censuses = new Map<string, Record<string, number>>();

  private cachedCensus<Row extends Record<string, number>>(census: {
    sql: string;
    binds: ReplicaBindValue[];
  }): Row | undefined {
    const key = `${census.sql}\u0000${JSON.stringify(census.binds)}`;
    const hit = this.censuses.get(key);
    if (hit) return hit as Row;
    const computed = this.one<Row>(census.sql, census.binds);
    if (computed) this.censuses.set(key, computed);
    return computed;
  }

  private invalidateCensuses(): void {
    this.censuses.clear();
  }

  /**
   * The census index (#922 C3): one entry per row on `censusClass`, so each
   * order guard is a seek instead of an aggregate over the entity. Spelled
   * EXACTLY as `censusSql`'s probes spell it, or SQLite serves neither, and
   * created for the ordered column AND its tie-break because both carry guards.
   */
  private readonly censusIndexes = new Set<string>();

  private ensureCensusIndex(entity: string, column: string): void {
    const key = `${entity}\u0000${column}`;
    if (this.censusIndexes.has(key)) return;
    this.censusIndexes.add(key);
    if (this.censusIndexes.size > ORDER_INDEX_MAX) return;
    this.driver.exec(
      `CREATE INDEX IF NOT EXISTS replica_row_cen_${orderIndexSuffix(key)}
         ON replica_row(shape_id, entity, ${censusClass(column)});`
    );
  }

  private ensureOrderIndex(entity: string, plan: ReplicaReadPlan): void {
    const column = plan.orderColumn;
    if (column === undefined) return;
    this.ensureCensusIndex(entity, column);
    if (plan.orderTieBreak !== undefined)
      this.ensureCensusIndex(entity, plan.orderTieBreak);
    const direction = plan.orderDirection === "desc" ? "DESC" : "ASC";
    const tieBreak = plan.orderTieBreak;
    const key = `${entity}\u0000${column}\u0000${direction}\u0000${tieBreak ?? ""}`;
    if (this.orderIndexes.has(key)) return;
    this.orderIndexes.add(key);
    if (this.orderIndexes.size > ORDER_INDEX_MAX) return;
    const terms = [
      "shape_id",
      "entity",
      `${jsonValue(column)} ${direction}`,
      ...(tieBreak === undefined ? [] : [`${jsonValue(tieBreak)} ASC`]),
      "row_id ASC",
    ];
    this.driver.exec(
      `CREATE INDEX IF NOT EXISTS replica_row_ord_${orderIndexSuffix(key)}
         ON replica_row(${terms.join(", ")});`
    );
  }

  private upsert(
    row: ReplicaSnapshotRow,
    knownSchema?: ReplicaEntitySchema,
    fromSnapshot = false
  ): void {
    const serverVersion = row.rowVersion ?? 0;
    if (!fromSnapshot) {
      const current = this.storedVersion(row.shapeId, row.entity, row.rowId);
      if (current && current.server_version > serverVersion) return;
    }
    this.run(
      `INSERT INTO replica_row(shape_id, entity, row_id, payload_json, oversized_json, server_version)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(shape_id, entity, row_id) DO UPDATE SET
         payload_json = excluded.payload_json,
         oversized_json = excluded.oversized_json,
         server_version = excluded.server_version`,
      [
        row.shapeId,
        row.entity,
        row.rowId,
        JSON.stringify(row.values),
        JSON.stringify(row.oversizedFields ?? []),
        serverVersion,
      ]
    );
    const schema = knownSchema ?? this.schema(row.shapeId, row.entity);
    if (!schema) {
      throw new ReplicaProtocolError(
        `Row references unknown shape entity ${row.shapeId}/${row.entity}`
      );
    }
    this.indexRow(row, schema, fromSnapshot);
  }

  private deleteRow(
    shapeId: string,
    entity: string,
    rowId: string,
    serverVersion?: number
  ): void {
    if (serverVersion !== undefined) {
      const current = this.storedVersion(shapeId, entity, rowId);
      if (current && current.server_version > serverVersion) return;
    }
    this.indexedSinceOptimize += 1;
    this.run(`DELETE FROM replica_search WHERE rowid = ${SEARCH_ROWID}`, [
      shapeId,
      entity,
      rowId,
    ]);
    this.run(
      "DELETE FROM replica_search_gap WHERE shape_id = ? AND entity = ? AND row_id = ?",
      [shapeId, entity, rowId]
    );
    this.run(
      "DELETE FROM replica_row WHERE shape_id = ? AND entity = ? AND row_id = ?",
      [shapeId, entity, rowId]
    );
  }

  private indexRow(
    row: ReplicaSnapshotRow,
    schema: ReplicaEntitySchema,
    fromSnapshot = false
  ): void {
    this.indexedSinceOptimize += 1;
    const spec = REPLICA_LOCAL_SEARCH[row.entity];
    if (!spec) return this.unindexRow(row, fromSnapshot);
    const required = replicaSearchRequiredColumns(spec);
    if (required.some((column) => !schema.columns.includes(column)))
      return this.unindexRow(row, fromSnapshot);
    const oversized = new Set(row.oversizedFields);
    const unavailable = required.find((column) => oversized.has(column));
    if (unavailable) {
      return this.recordSearchGap(
        row,
        `oversized indexed field ${unavailable}`,
        fromSnapshot
      );
    }
    if (spec.deletedColumn) {
      const deleted = row.values[spec.deletedColumn];
      if (
        deleted !== undefined &&
        deleted !== null &&
        typeof deleted === "object"
      ) {
        return this.recordSearchGap(
          row,
          `non-scalar deletion field ${spec.deletedColumn}`,
          fromSnapshot
        );
      }
      if (deleted !== undefined && deleted !== null)
        return this.unindexRow(row, fromSnapshot);
    }
    const parts: string[] = [];
    for (const column of spec.columns) {
      const value = row.values[column];
      if (value === undefined || value === null) continue;
      if (typeof value === "object") {
        return this.recordSearchGap(
          row,
          `non-scalar indexed field ${column}`,
          fromSnapshot
        );
      }
      parts.push(String(value));
    }
    // OR REPLACE, not delete-then-insert: the entry is addressed by the same
    // rowid either way, so one statement does what two did.
    this.run(
      `INSERT OR REPLACE INTO replica_search(rowid, shape_id, entity, row_id, body)
       VALUES (${SEARCH_ROWID}, ?, ?, ?, ?)`,
      [
        row.shapeId,
        row.entity,
        row.rowId,
        row.shapeId,
        row.entity,
        row.rowId,
        parts.join("\n"),
      ]
    );
    if (!fromSnapshot) this.clearSearchGap(row);
  }

  /** Drop whatever the search index held for a row that must not be in it. */
  private unindexRow(row: ReplicaSnapshotRow, fromSnapshot: boolean): void {
    if (fromSnapshot) return;
    this.run(`DELETE FROM replica_search WHERE rowid = ${SEARCH_ROWID}`, [
      row.shapeId,
      row.entity,
      row.rowId,
    ]);
    this.clearSearchGap(row);
  }

  private clearSearchGap(row: ReplicaSnapshotRow): void {
    this.run(
      "DELETE FROM replica_search_gap WHERE shape_id = ? AND entity = ? AND row_id = ?",
      [row.shapeId, row.entity, row.rowId]
    );
  }

  private recordSearchGap(
    row: ReplicaSnapshotRow,
    reason: string,
    fromSnapshot = false
  ): void {
    if (!fromSnapshot) {
      this.run(`DELETE FROM replica_search WHERE rowid = ${SEARCH_ROWID}`, [
        row.shapeId,
        row.entity,
        row.rowId,
      ]);
    }
    // OR REPLACE so a resumed bootstrap page re-records the same gap instead
    // of failing on its own primary key.
    this.run(
      `INSERT OR REPLACE INTO replica_search_gap(shape_id, entity, row_id, reason)
       VALUES (?, ?, ?, ?)`,
      [row.shapeId, row.entity, row.rowId, reason]
    );
  }

  /** Identity, epoch and catalog checks shared by single-shot and windowed bootstrap. */
  private validateHeader(
    header: ReplicaBootstrapHeader
  ): Map<string, ReplicaEntitySchema> {
    if (header.protocolVersion !== REPLICA_PROTOCOL_VERSION) {
      throw new ReplicaRebootstrapRequiredError("protocol-mismatch");
    }
    if (header.vaultId !== this.expectedVaultId) {
      throw new ReplicaRebootstrapRequiredError("vault-mismatch");
    }
    if (!header.schemaEpoch)
      throw new ReplicaProtocolError("Schema epoch is required");
    const schemas = new Map<string, ReplicaEntitySchema>();
    const shapeIds = new Set<string>();
    for (const shape of header.shapes) {
      if (!shape.shapeId || !shape.appId) {
        throw new ReplicaProtocolError("Shape identity is required");
      }
      if (shapeIds.has(shape.shapeId)) {
        throw new ReplicaProtocolError(`Duplicate shape ${shape.shapeId}`);
      }
      shapeIds.add(shape.shapeId);
      for (const schema of shape.entities) {
        validateSchema(schema);
        const key = `${shape.shapeId}\u0000${schema.entity}`;
        if (schemas.has(key))
          throw new ReplicaProtocolError(`Duplicate shape entity ${key}`);
        schemas.set(key, schema);
      }
    }
    return schemas;
  }

  private validateSnapshot(snapshot: ReplicaSnapshot): void {
    const schemas = this.validateHeader(snapshot);
    validateCursor(snapshot.cursor);
    const rowIds = new Set<string>();
    for (const row of snapshot.rows) {
      const schema = schemas.get(`${row.shapeId}\u0000${row.entity}`);
      if (!schema) {
        throw new ReplicaProtocolError(
          `Snapshot row references unknown shape entity ${row.shapeId}/${row.entity}`
        );
      }
      const key = `${row.shapeId}\u0000${row.entity}\u0000${row.rowId}`;
      if (rowIds.has(key))
        throw new ReplicaProtocolError(`Duplicate replica row ${key}`);
      rowIds.add(key);
      this.validateRow(row, schema);
    }
  }

  private validateRow(
    row: ReplicaSnapshotRow,
    schema: ReplicaEntitySchema
  ): void {
    if (!row.rowId)
      throw new ReplicaProtocolError("Replica row id is required");
    if (
      row.rowVersion !== undefined &&
      (!Number.isSafeInteger(row.rowVersion) || row.rowVersion < 0)
    ) {
      throw new ReplicaProtocolError("Replica row version is invalid");
    }
    const columns = new Set(schema.columns);
    for (const field of Object.keys(row.values)) {
      if (!columns.has(field)) {
        throw new ReplicaProtocolError(
          `Row contains unshaped field ${schema.entity}.${field}`
        );
      }
      validateValue(row.values[field], `${schema.entity}.${field}`);
    }
    const primaryValue = row.values[schema.primaryKey];
    const primaryMatches =
      schema.primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY
        ? primaryValue === row.rowId
        : (typeof primaryValue === "string" ||
            typeof primaryValue === "number") &&
          String(primaryValue) === row.rowId;
    if (!primaryMatches) {
      throw new ReplicaProtocolError(
        `Replica row id does not match ${schema.entity}.${schema.primaryKey}`
      );
    }
    for (const field of row.oversizedFields ?? []) {
      if (!columns.has(field)) {
        throw new ReplicaProtocolError(
          `Unknown oversized field ${schema.entity}.${field}`
        );
      }
      if (field in row.values) {
        throw new ReplicaProtocolError(
          `Oversized field ${schema.entity}.${field} carried a value`
        );
      }
    }
  }

  private changeMismatch(
    meta: MetaRow,
    batch: ReplicaChangeBatch
  ): RebootstrapReason | undefined {
    if (batch.protocolVersion !== REPLICA_PROTOCOL_VERSION)
      return "protocol-mismatch";
    if (batch.schemaEpoch !== meta.schema_epoch) return "schema-mismatch";
    if (
      batch.from.epoch !== meta.cursor_epoch ||
      batch.to.epoch !== meta.cursor_epoch
    ) {
      return "epoch-mismatch";
    }
    // A GAP IS A BATCH THAT STARTS AHEAD OF US, AND ONLY THAT (#922 E3).
    // Two catch-up paths legitimately hold the same cursor at once — the
    // bootstrap's convergence replay and the change feed's own sync — so the
    // slower one arrives with a `from` the faster one has already passed.
    // That batch skipped nothing; it OVERLAPS, and every change in it is an
    // idempotent upsert or delete under the same server-version guard. Calling
    // it a gap wiped the store and demanded a re-bootstrap that raced exactly
    // the same way, which is the loop this rule ends.
    if (batch.from.seq > meta.cursor_seq || batch.to.seq < batch.from.seq)
      return "cursor-gap";
    return undefined;
  }

  private transaction(work: () => void): void {
    this.driver.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.driver.exec("COMMIT");
    } catch (error) {
      this.driver.exec("ROLLBACK");
      throw error;
    }
  }

  /** When set, `run` RECORDS instead of executing (see `bootstrapPageAsync`). */
  private recording: ReplicaStatement[] | undefined;

  private run(sql: string, bind: readonly ReplicaBindValue[] = []): void {
    // EVERY write goes through here, which is why the census cache is dropped
    // here and not at each call site: a new write path cannot forget to.
    this.invalidateCensuses();
    if (this.recording) {
      this.recording.push({ sql, bind: [...bind] });
      return;
    }
    this.driver.run(sql, bind);
  }

  private all<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = []
  ): T[] {
    return this.driver.all<T>(sql, bind);
  }

  private one<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = []
  ): T | undefined {
    return this.all<T>(sql, bind)[0];
  }
}

function validateCursor(cursor: ReplicaCursor): void {
  if (!cursor.epoch || !Number.isSafeInteger(cursor.seq) || cursor.seq < 0) {
    throw new ReplicaProtocolError("Replica cursor is invalid");
  }
}

function validateSchema(schema: ReplicaEntitySchema): void {
  if (!schema.entity || !schema.primaryKey)
    throw new ReplicaProtocolError("Entity schema is invalid");
  const columns = new Set(schema.columns);
  if (
    columns.size !== schema.columns.length ||
    schema.columns.some((column) => !column) ||
    !columns.has(schema.primaryKey)
  ) {
    throw new ReplicaProtocolError(
      `Entity ${schema.entity} has invalid columns`
    );
  }
  if (
    schema.hasUnavailableFields !== undefined &&
    typeof schema.hasUnavailableFields !== "boolean"
  ) {
    throw new ReplicaProtocolError(
      `Entity ${schema.entity} has invalid availability metadata`
    );
  }
}

function validateValue(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new ReplicaProtocolError(`Replica value ${path} is not finite`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value))
      validateValue(item, `${path}.${key}`);
    return;
  }
  throw new ReplicaProtocolError(`Replica value ${path} is not JSON-safe`);
}

function parseStringArray(value: string, label: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new ReplicaProtocolError(`Stored ${label} metadata is invalid`);
  }
  return parsed;
}

function dedupeInvalidations(
  values: ReplicaInvalidation[]
): ReplicaInvalidation[] {
  const byKey = new Map<string, ReplicaInvalidation>();
  for (const value of values) {
    byKey.set(
      `${value.shapeId}\u0000${value.entity}\u0000${value.rowId ?? ""}`,
      value
    );
  }
  return [...byKey.values()];
}
