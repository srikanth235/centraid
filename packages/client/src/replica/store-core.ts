// governance: allow-repo-hygiene file-size-limit (#419) cohesive driver-neutral SQLite store core; decomposition is outside this issue
import {
  OnlineOnlyError,
  ReplicaProtocolError,
  ReplicaRebootstrapRequiredError,
  ReplicaSearchRefusedError,
} from "./errors.js";
import type { RebootstrapReason } from "./errors.js";
import { applyOptimisticMutations } from "./query.js";
import {
  assertReplicaPage,
  assertReplicaTieCensus,
  planReplicaRead,
} from "./read-plan.js";
import type {
  ReplicaOverlayBinding,
  ReplicaPlannedRow,
  ReplicaTieCensusRow,
} from "./read-plan.js";
import {
  REPLICA_LOCAL_SEARCH,
  replicaFtsMatchExpression,
  replicaLocalSearchSpec,
  replicaPendingSearchMatch,
  replicaPendingSearchRank,
  replicaSearchRequiredColumns,
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

export type ReplicaBindValue = string | number | null;

export interface ReplicaSqliteDriver {
  run: (sql: string, bind?: readonly ReplicaBindValue[]) => void;
  all: <T extends object>(
    sql: string,
    bind?: readonly ReplicaBindValue[]
  ) => T[];
  exec: (sql: string) => void;
  close: () => void;
  assertCapabilities?: () => void;
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

export interface ReplicaBootstrapResume {
  after: string | null;
  commitCursor: ReplicaCursor;
  pages: number;
}

export interface ReplicaBootstrapAdvance {
  after: string | null;
  commitCursor: ReplicaCursor;
  pages: number;
}

export interface ReplicaStorageBytes {
  pageSize: number;
  pageCount: number;
  freePages: number;
  bytes: number;
  freeBytes: number;
}

const LOCAL_REPLICA_SCHEMA_VERSION = 8;

const FTS_OPTIMIZE_ROW_INTERVAL = 20_000;

const LARGE_DELETION_BATCH = 1_000;

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
    app_id TEXT NOT NULL,
    purpose TEXT NOT NULL
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

const SEARCH_ROWID = `(SELECT row_key FROM replica_row
     WHERE shape_id = ? AND entity = ? AND row_id = ?)`;

export class ReplicaSqliteStore {
  private indexedSinceOptimize = 0;

  constructor(
    protected readonly driver: ReplicaSqliteDriver,
    private readonly expectedVaultId: string,
    private readonly durability: ReplicaDurability = "durable"
  ) {
    this.driver.exec("PRAGMA foreign_keys=ON;");
    this.driver.exec("PRAGMA journal_mode=DELETE;");
    this.driver.exec("PRAGMA synchronous=FULL;");
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

  catalog(): ReplicaShape[] {
    return this.all<{ shape_id: string; app_id: string; purpose: string }>(
      "SELECT shape_id, app_id, purpose FROM replica_shape ORDER BY shape_id"
    ).map((shape) => ({
      shapeId: shape.shape_id,
      appId: shape.app_id,
      purpose: shape.purpose,
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
      for (const row of snapshot.rows) this.upsert(row);
      this.writeMeta(snapshot, snapshot.cursor);
    });
    this.reclaimFreePages();
    this.optimizeSearchIndex();
    return snapshot.cursor;
  }

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

  bootstrapPage(
    rows: readonly ReplicaSnapshotRow[],
    advance?: ReplicaBootstrapAdvance
  ): void {
    this.requireBootstrapProgress();
    if (advance) validateCursor(advance.commitCursor);
    this.transaction(() => {
      for (const row of rows) {
        const schema = this.schema(row.shapeId, row.entity);
        if (!schema) {
          throw new ReplicaProtocolError(
            `Bootstrap row references unknown shape entity ${row.shapeId}/${row.entity}`
          );
        }
        this.validateRow(row, schema);
        this.upsert(row, schema);
      }
      if (!advance) return;
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
    });
    this.maybeOptimizeSearchIndex();
  }

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
    this.optimizeSearchIndex();
    return cursor;
  }

  applyChanges(batch: ReplicaChangeBatch): ApplyChangesResult {
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

    const invalidations: ReplicaInvalidation[] = [];
    this.transaction(() => {
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
    const plan = planReplicaRead(
      schema,
      request,
      now,
      this.overlay(request, schema, relevant)
    );
    const planned = this.all<ReplicaPlannedRow>(plan.sql, plan.binds);
    assertReplicaPage(planned, plan);
    if (plan.tieCensus) {
      const census = this.one<ReplicaTieCensusRow>(
        plan.tieCensus.sql,
        plan.tieCensus.binds
      );
      if (census) assertReplicaTieCensus(census);
    }
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
    };
  }

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
    const requestedLimit = request.limit ?? 100;
    if (!Number.isSafeInteger(requestedLimit)) {
      throw new ReplicaProtocolError("Search limit must be a safe integer");
    }
    const limit = Math.min(Math.max(requestedLimit, 1), 1000);
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
    const hasOpaqueIdentity =
      schema.primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY;
    const fetchLimit = limit + relevant.length + (hasOpaqueIdentity ? 1 : 0);
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
    };
  }

  wipe(): void {
    this.transaction(() => this.clear());
    this.reclaimFreePages();
  }

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
    for (const shape of shapes) {
      this.run(
        "INSERT INTO replica_shape(shape_id, app_id, purpose) VALUES (?, ?, ?)",
        [shape.shapeId, shape.appId, shape.purpose]
      );
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

  private enableIncrementalVacuum(): void {
    try {
      this.driver.exec("PRAGMA auto_vacuum=INCREMENTAL;");
      this.driver.exec("VACUUM;");
    } catch {
      // Intentionally empty.
    }
  }

  private reclaimFreePages(): void {
    try {
      if (this.pragmaNumber("freelist_count") === 0) return;
      this.all("PRAGMA incremental_vacuum");
      if (this.pragmaNumber("freelist_count") === 0) return;
      this.driver.exec("VACUUM;");
    } catch {
      // Intentionally empty.
    }
  }

  private maybeOptimizeSearchIndex(): void {
    if (this.indexedSinceOptimize < FTS_OPTIMIZE_ROW_INTERVAL) return;
    this.optimizeSearchIndex();
  }

  private optimizeSearchIndex(): void {
    this.indexedSinceOptimize = 0;
    try {
      this.run("INSERT INTO replica_search(replica_search) VALUES('optimize')");
    } catch {
      // Intentionally empty.
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

  private schema(
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

  private upsert(
    row: ReplicaSnapshotRow,
    knownSchema?: ReplicaEntitySchema
  ): void {
    const serverVersion = row.rowVersion ?? 0;
    const current = this.one<{ server_version: number }>(
      `SELECT server_version FROM replica_row
        WHERE shape_id = ? AND entity = ? AND row_id = ?`,
      [row.shapeId, row.entity, row.rowId]
    );
    if (current && current.server_version > serverVersion) return;
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
    this.indexRow(row, schema);
  }

  private deleteRow(
    shapeId: string,
    entity: string,
    rowId: string,
    serverVersion?: number
  ): void {
    if (serverVersion !== undefined) {
      const current = this.one<{ server_version: number }>(
        `SELECT server_version FROM replica_row
          WHERE shape_id = ? AND entity = ? AND row_id = ?`,
        [shapeId, entity, rowId]
      );
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

  private indexRow(row: ReplicaSnapshotRow, schema: ReplicaEntitySchema): void {
    this.indexedSinceOptimize += 1;
    this.run(`DELETE FROM replica_search WHERE rowid = ${SEARCH_ROWID}`, [
      row.shapeId,
      row.entity,
      row.rowId,
    ]);
    this.run(
      "DELETE FROM replica_search_gap WHERE shape_id = ? AND entity = ? AND row_id = ?",
      [row.shapeId, row.entity, row.rowId]
    );
    const spec = REPLICA_LOCAL_SEARCH[row.entity];
    if (!spec) return;
    const required = replicaSearchRequiredColumns(spec);
    if (required.some((column) => !schema.columns.includes(column))) return;
    const oversized = new Set(row.oversizedFields);
    const unavailable = required.find((column) => oversized.has(column));
    if (unavailable) {
      this.recordSearchGap(row, `oversized indexed field ${unavailable}`);
      return;
    }
    if (spec.deletedColumn) {
      const deleted = row.values[spec.deletedColumn];
      if (
        deleted !== undefined &&
        deleted !== null &&
        typeof deleted === "object"
      ) {
        this.recordSearchGap(
          row,
          `non-scalar deletion field ${spec.deletedColumn}`
        );
        return;
      }
      if (deleted !== undefined && deleted !== null) return;
    }
    const parts: string[] = [];
    for (const column of spec.columns) {
      const value = row.values[column];
      if (value === undefined || value === null) continue;
      if (typeof value === "object") {
        this.recordSearchGap(row, `non-scalar indexed field ${column}`);
        return;
      }
      parts.push(String(value));
    }
    this.run(
      `INSERT INTO replica_search(rowid, shape_id, entity, row_id, body)
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
  }

  private recordSearchGap(row: ReplicaSnapshotRow, reason: string): void {
    this.run(
      `INSERT INTO replica_search_gap(shape_id, entity, row_id, reason)
       VALUES (?, ?, ?, ?)`,
      [row.shapeId, row.entity, row.rowId, reason]
    );
  }

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
      if (!shape.shapeId || !shape.appId || !shape.purpose) {
        throw new ReplicaProtocolError(
          "Shape identity and purpose are required"
        );
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
    if (batch.from.seq !== meta.cursor_seq || batch.to.seq < batch.from.seq)
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

  private run(sql: string, bind: readonly ReplicaBindValue[] = []): void {
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
