// governance: allow-repo-hygiene file-size-limit (#419) cohesive driver-neutral SQLite store core; decomposition is outside this issue
import {
  OnlineOnlyError,
  ReplicaProtocolError,
  ReplicaRebootstrapRequiredError,
  type RebootstrapReason,
} from './errors.js';
import { applyOptimisticMutations, evaluateReplicaRead } from './query.js';
import {
  REPLICA_LOCAL_SEARCH,
  replicaFtsMatchExpression,
  replicaLocalSearchSpec,
  replicaSearchRequiredColumns,
} from './search.js';
import {
  REPLICA_PROTOCOL_VERSION,
  REPLICA_SYNTHETIC_PRIMARY_KEY,
  type ApplyChangesResult,
  type OptimisticMutation,
  type ReplicaBootstrapHeader,
  type ReplicaChangeBatch,
  type ReplicaCursor,
  type ReplicaEntitySchema,
  type ReplicaInvalidation,
  type ReplicaReadRequest,
  type ReplicaReadWireResult,
  type ReplicaRow,
  type ReplicaRowEnvelope,
  type ReplicaSearchRequest,
  type ReplicaSearchWireResult,
  type ReplicaShape,
  type ReplicaSnapshot,
  type ReplicaSnapshotRow,
} from './types.js';

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
  run(sql: string, bind?: readonly ReplicaBindValue[]): void;
  /** Run one parameterized query, materializing each row as a plain object. */
  all<T extends object>(sql: string, bind?: readonly ReplicaBindValue[]): T[];
  /** Execute a multi-statement, bindless SQL script (DDL, PRAGMA, tx control). */
  exec(sql: string): void;
  /** Release the underlying handle. */
  close(): void;
  /**
   * Optional open-time capability gate. Called once after the base PRAGMAs and
   * before schema creation so a driver can fail loud (e.g. probe FTS5 on a
   * native build that omitted the extension) instead of throwing opaquely
   * mid-bootstrap.
   */
  assertCapabilities?(): void;
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
 * present itself as complete, and the next open re-bootstraps from scratch.
 */
interface StoredBootstrapProgress {
  protocol_version: number;
  vault_id: string;
  schema_epoch: string;
}

interface StoredSearchRow extends StoredRow {
  rank: number;
  snippet: string | null;
}

const LOCAL_REPLICA_SCHEMA_VERSION = 4;

const DDL = `
  CREATE TABLE IF NOT EXISTS replica_bootstrap_progress (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    protocol_version INTEGER NOT NULL,
    vault_id TEXT NOT NULL,
    schema_epoch TEXT NOT NULL
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
    shape_id TEXT NOT NULL,
    entity TEXT NOT NULL,
    row_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    oversized_json TEXT NOT NULL,
    PRIMARY KEY (shape_id, entity, row_id),
    FOREIGN KEY (shape_id, entity)
      REFERENCES replica_entity_schema(shape_id, entity) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS replica_row_entity ON replica_row(shape_id, entity);
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
 * The entire replica store logic, written once over {@link ReplicaSqliteDriver}.
 * Fully synchronous — the async {@link import('./store.js').ReplicaStore}
 * surface is added by the transport-specific wrappers (worker RPC on web, a
 * thin promise wrapper on native).
 */
export class ReplicaSqliteStore {
  constructor(
    protected readonly driver: ReplicaSqliteDriver,
    private readonly expectedVaultId: string,
  ) {
    this.driver.exec('PRAGMA foreign_keys=ON;');
    this.driver.exec('PRAGMA journal_mode=DELETE;');
    this.driver.exec('PRAGMA synchronous=FULL;');
    this.driver.assertCapabilities?.();
    this.initializeSchema();
  }

  close(): void {
    this.driver.close();
  }

  status(): { cursor: ReplicaCursor | null; schemaEpoch: string | null } {
    const meta = this.meta();
    return {
      cursor: meta ? { epoch: meta.cursor_epoch, seq: meta.cursor_seq } : null,
      schemaEpoch: meta?.schema_epoch ?? null,
    };
  }

  /** Shape metadata survives reopen and rebuilds the app/entity lookup offline. */
  catalog(): ReplicaShape[] {
    return this.all<{ shape_id: string; app_id: string; purpose: string }>(
      'SELECT shape_id, app_id, purpose FROM replica_shape ORDER BY shape_id',
    ).map((shape) => ({
      shapeId: shape.shape_id,
      appId: shape.app_id,
      purpose: shape.purpose,
      entities: this.all<StoredSchema & { entity: string }>(
        `SELECT entity, primary_key, columns_json, has_unavailable_fields
           FROM replica_entity_schema WHERE shape_id = ? ORDER BY entity`,
        [shape.shape_id],
      ).map((schema) => ({
        entity: schema.entity,
        primaryKey: schema.primary_key,
        columns: parseStringArray(schema.columns_json, 'columns'),
        ...(schema.has_unavailable_fields === 1 ? { hasUnavailableFields: true } : {}),
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
    return snapshot.cursor;
  }

  /**
   * Open a windowed bootstrap: clear the replica, install the page-1 catalog and
   * record the header durably. No `replica_meta` row is written, so until
   * {@link bootstrapCommit} the replica reports no cursor and the session
   * re-bootstraps from scratch — a crash between pages can never leave a partial
   * replica claiming to be complete. Re-opening a bootstrap restarts it.
   */
  bootstrapBegin(header: ReplicaBootstrapHeader): void {
    this.validateHeader(header);
    this.transaction(() => {
      this.clear();
      this.writeShapes(header.shapes);
      this.run(
        `INSERT INTO replica_bootstrap_progress
           (singleton, protocol_version, vault_id, schema_epoch)
         VALUES (1, ?, ?, ?)`,
        [header.protocolVersion, header.vaultId, header.schemaEpoch],
      );
    });
  }

  /** Apply one window of rows atomically against the open bootstrap's catalog. */
  bootstrapPage(rows: readonly ReplicaSnapshotRow[]): void {
    this.requireBootstrapProgress();
    this.transaction(() => {
      for (const row of rows) {
        const schema = this.schema(row.shapeId, row.entity);
        if (!schema) {
          throw new ReplicaProtocolError(
            `Bootstrap row references unknown shape entity ${row.shapeId}/${row.entity}`,
          );
        }
        this.validateRow(row, schema);
        this.upsert(row, schema);
      }
    });
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
          protocolVersion: progress.protocol_version as typeof REPLICA_PROTOCOL_VERSION,
          vaultId: progress.vault_id,
          schemaEpoch: progress.schema_epoch,
        },
        cursor,
      );
      this.run('DELETE FROM replica_bootstrap_progress WHERE singleton = 1');
    });
    return cursor;
  }

  applyChanges(batch: ReplicaChangeBatch): ApplyChangesResult {
    const meta = this.meta();
    if (!meta) throw new ReplicaRebootstrapRequiredError('not-bootstrapped');
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
            `Change references unknown shape entity ${change.shapeId}/${change.entity}`,
          );
        }
        if (change.op === 'delete') {
          this.deleteRow(change.shapeId, change.entity, change.rowId);
        } else {
          this.validateRow(change, schema);
          this.upsert(change, schema);
        }
        invalidations.push({
          shapeId: change.shapeId,
          entity: change.entity,
          rowId: change.rowId,
          source: 'canonical',
        });
      }
      this.run('UPDATE replica_meta SET cursor_epoch = ?, cursor_seq = ? WHERE singleton = 1', [
        batch.to.epoch,
        batch.to.seq,
      ]);
    });
    return {
      cursor: batch.to,
      invalidations: dedupeInvalidations(invalidations),
      outcomes: batch.outcomes ?? [],
    };
  }

  read(
    request: ReplicaReadRequest,
    mutations: OptimisticMutation[] = [],
    now: Date = new Date(),
  ): ReplicaReadWireResult {
    const meta = this.meta();
    if (!meta) throw new ReplicaRebootstrapRequiredError('not-bootstrapped');
    const schema = this.schema(request.shapeId, request.entity);
    if (!schema) {
      throw new ReplicaProtocolError(
        `Shape does not contain entity ${request.shapeId}/${request.entity}`,
      );
    }
    const canonical = this.scan(
      request.shapeId,
      request.entity,
      schema.hasUnavailableFields === true,
    );
    const relevant = mutations.filter(
      (mutation) => mutation.shapeId === request.shapeId && mutation.entity === request.entity,
    );
    return {
      rows: evaluateReplicaRead(canonical, schema, request, relevant, now),
      cursor: { epoch: meta.cursor_epoch, seq: meta.cursor_seq },
      dependency: { shapeId: request.shapeId, entity: request.entity },
    };
  }

  /**
   * FTS-backed local search over eager replica metadata. A feature that could
   * produce an incomplete or differently-ranked answer fails online-only.
   */
  search(
    request: ReplicaSearchRequest,
    mutations: OptimisticMutation[] = [],
  ): ReplicaSearchWireResult {
    const meta = this.meta();
    if (!meta) throw new ReplicaRebootstrapRequiredError('not-bootstrapped');
    const schema = this.schema(request.shapeId, request.entity);
    if (!schema) {
      throw new ReplicaProtocolError(
        `Shape does not contain entity ${request.shapeId}/${request.entity}`,
      );
    }
    const spec = replicaLocalSearchSpec(request.entity);
    const required = replicaSearchRequiredColumns(spec);
    const missing = required.filter((column) => !schema.columns.includes(column));
    if (missing.length > 0) {
      throw new OnlineOnlyError(
        `replica shape does not expose indexed column(s) ${missing.join(', ')}`,
      );
    }
    if ((request.where?.length ?? 0) > 0) {
      throw new OnlineOnlyError('filtered search requires canonical SQLite consent predicates');
    }
    const gap = this.one<{ reason: string }>(
      `SELECT reason FROM replica_search_gap
        WHERE shape_id = ? AND entity = ? LIMIT 1`,
      [request.shapeId, request.entity],
    );
    if (gap) throw new OnlineOnlyError(`replica search index is incomplete: ${gap.reason}`);

    const match = replicaFtsMatchExpression(request.query);
    const requestedLimit = request.limit ?? 100;
    if (!Number.isSafeInteger(requestedLimit)) {
      throw new ReplicaProtocolError('Search limit must be a safe integer');
    }
    const limit = Math.min(Math.max(requestedLimit, 1), 1000);
    const relevant = mutations.filter(
      (mutation) => mutation.shapeId === request.shapeId && mutation.entity === request.entity,
    );
    const indexed = new Set(required);
    for (const mutation of relevant) {
      if (
        mutation.op === 'upsert' &&
        Object.keys(mutation.values).some((column) => indexed.has(column))
      ) {
        throw new OnlineOnlyError(
          'ranking a pending edit to indexed text requires canonical SQLite search',
        );
      }
    }
    // A pending delete can remove at most one canonical hit. Pull one bounded
    // replacement per delete so applying the overlay still fills the limit.
    const hasOpaqueIdentity = schema.primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY;
    const fetchLimit =
      limit +
      relevant.filter((mutation) => mutation.op === 'delete').length +
      (hasOpaqueIdentity ? 1 : 0);
    if (fetchLimit > 10_000) {
      throw new OnlineOnlyError('the pending search overlay exceeds the local bounded work limit');
    }
    const tieOrder = hasOpaqueIdentity ? '' : ', replica_search.row_id';
    const rows = this.all<StoredSearchRow>(
      `SELECT replica_search.row_id, replica_row.payload_json,
              replica_row.oversized_json, replica_search.rank AS rank,
              snippet(replica_search, -1, '⟦', '⟧', '…', 12) AS snippet
         FROM replica_search
         JOIN replica_row
           ON replica_row.shape_id = replica_search.shape_id
          AND replica_row.entity = replica_search.entity
          AND replica_row.row_id = replica_search.row_id
        WHERE replica_search MATCH ?
          AND replica_search.shape_id = ? AND replica_search.entity = ?
        ORDER BY replica_search.rank${tieOrder}
        LIMIT ?`,
      [match, request.shapeId, request.entity, fetchLimit],
    ).map((row) => ({
      rowId: row.row_id,
      values: {
        ...(JSON.parse(row.payload_json) as ReplicaRow),
        _rank: row.rank,
        _snippet: row.snippet ?? '',
      },
      oversizedFields: parseStringArray(row.oversized_json, 'oversized fields'),
      hasUnavailableFields: schema.hasUnavailableFields === true,
    }));
    const canonicalHitIds = new Set(rows.map((row) => row.rowId));
    const overlaid = applyOptimisticMutations(rows, relevant, schema).filter((row) =>
      canonicalHitIds.has(row.rowId),
    );
    if (!hasOpaqueIdentity) {
      const nonTextPrimary = overlaid.find(
        (row) => typeof row.values[schema.primaryKey] !== 'string',
      );
      if (nonTextPrimary) {
        throw new OnlineOnlyError(
          'non-text primary-key ties require canonical SQLite affinity ordering',
        );
      }
    } else if (
      overlaid.length > limit &&
      overlaid[limit - 1]?.values._rank === overlaid[limit]?.values._rank
    ) {
      throw new OnlineOnlyError(
        'an equal-rank LIMIT boundary requires the undisclosed canonical primary key',
      );
    }
    return {
      rows: overlaid.slice(0, limit),
      cursor: { epoch: meta.cursor_epoch, seq: meta.cursor_seq },
      dependency: { shapeId: request.shapeId, entity: request.entity },
    };
  }

  wipe(): void {
    this.transaction(() => this.clear());
  }

  private writeShapes(shapes: readonly ReplicaShape[]): void {
    for (const shape of shapes) {
      this.run('INSERT INTO replica_shape(shape_id, app_id, purpose) VALUES (?, ?, ?)', [
        shape.shapeId,
        shape.appId,
        shape.purpose,
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
          ],
        );
      }
    }
  }

  private writeMeta(header: Omit<ReplicaBootstrapHeader, 'shapes'>, cursor: ReplicaCursor): void {
    this.run(
      `INSERT INTO replica_meta
         (singleton, protocol_version, vault_id, cursor_epoch, cursor_seq, schema_epoch)
       VALUES (1, ?, ?, ?, ?, ?)`,
      [header.protocolVersion, header.vaultId, cursor.epoch, cursor.seq, header.schemaEpoch],
    );
  }

  private requireBootstrapProgress(): StoredBootstrapProgress {
    const progress = this.one<StoredBootstrapProgress>(
      'SELECT protocol_version, vault_id, schema_epoch FROM replica_bootstrap_progress WHERE singleton = 1',
    );
    if (!progress) {
      throw new ReplicaProtocolError('No replica bootstrap is open');
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

  /**
   * The local replica is disposable derived state. During v0 development an
   * incompatible schema is rebuilt in place instead of being migrated.
   */
  private initializeSchema(): void {
    const version = this.one<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
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
      this.driver.exec(`PRAGMA user_version = ${LOCAL_REPLICA_SCHEMA_VERSION};`);
    });
  }

  private meta(): MetaRow | undefined {
    return this.one<MetaRow>('SELECT * FROM replica_meta WHERE singleton = 1');
  }

  private schema(shapeId: string, entity: string): ReplicaEntitySchema | undefined {
    const row = this.one<StoredSchema>(
      `SELECT primary_key, columns_json, has_unavailable_fields
         FROM replica_entity_schema WHERE shape_id = ? AND entity = ?`,
      [shapeId, entity],
    );
    if (!row) return undefined;
    return {
      entity,
      primaryKey: row.primary_key,
      columns: parseStringArray(row.columns_json, 'columns'),
      ...(row.has_unavailable_fields === 1 ? { hasUnavailableFields: true } : {}),
    };
  }

  private scan(
    shapeId: string,
    entity: string,
    hasUnavailableFields: boolean,
  ): ReplicaRowEnvelope[] {
    const rows = this.all<StoredRow>(
      `SELECT row_id, payload_json, oversized_json FROM replica_row
         WHERE shape_id = ? AND entity = ?`,
      [shapeId, entity],
    );
    return rows.map((row) => ({
      rowId: row.row_id,
      values: JSON.parse(row.payload_json) as ReplicaRow,
      oversizedFields: parseStringArray(row.oversized_json, 'oversized fields'),
      hasUnavailableFields,
    }));
  }

  private upsert(row: ReplicaSnapshotRow, knownSchema?: ReplicaEntitySchema): void {
    this.run(
      `INSERT INTO replica_row(shape_id, entity, row_id, payload_json, oversized_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(shape_id, entity, row_id) DO UPDATE SET
         payload_json = excluded.payload_json,
         oversized_json = excluded.oversized_json`,
      [
        row.shapeId,
        row.entity,
        row.rowId,
        JSON.stringify(row.values),
        JSON.stringify(row.oversizedFields ?? []),
      ],
    );
    const schema = knownSchema ?? this.schema(row.shapeId, row.entity);
    if (!schema) {
      throw new ReplicaProtocolError(
        `Row references unknown shape entity ${row.shapeId}/${row.entity}`,
      );
    }
    this.indexRow(row, schema);
  }

  private deleteRow(shapeId: string, entity: string, rowId: string): void {
    this.run('DELETE FROM replica_search WHERE shape_id = ? AND entity = ? AND row_id = ?', [
      shapeId,
      entity,
      rowId,
    ]);
    this.run('DELETE FROM replica_search_gap WHERE shape_id = ? AND entity = ? AND row_id = ?', [
      shapeId,
      entity,
      rowId,
    ]);
    this.run('DELETE FROM replica_row WHERE shape_id = ? AND entity = ? AND row_id = ?', [
      shapeId,
      entity,
      rowId,
    ]);
  }

  private indexRow(row: ReplicaSnapshotRow, schema: ReplicaEntitySchema): void {
    this.run('DELETE FROM replica_search WHERE shape_id = ? AND entity = ? AND row_id = ?', [
      row.shapeId,
      row.entity,
      row.rowId,
    ]);
    this.run('DELETE FROM replica_search_gap WHERE shape_id = ? AND entity = ? AND row_id = ?', [
      row.shapeId,
      row.entity,
      row.rowId,
    ]);
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
      if (deleted !== undefined && deleted !== null && typeof deleted === 'object') {
        this.recordSearchGap(row, `non-scalar deletion field ${spec.deletedColumn}`);
        return;
      }
      if (deleted !== undefined && deleted !== null) return;
    }
    const parts: string[] = [];
    for (const column of spec.columns) {
      const value = row.values[column];
      if (value === undefined || value === null) continue;
      if (typeof value === 'object') {
        this.recordSearchGap(row, `non-scalar indexed field ${column}`);
        return;
      }
      parts.push(String(value));
    }
    this.run('INSERT INTO replica_search(shape_id, entity, row_id, body) VALUES (?, ?, ?, ?)', [
      row.shapeId,
      row.entity,
      row.rowId,
      parts.join('\n'),
    ]);
  }

  private recordSearchGap(row: ReplicaSnapshotRow, reason: string): void {
    this.run(
      `INSERT INTO replica_search_gap(shape_id, entity, row_id, reason)
       VALUES (?, ?, ?, ?)`,
      [row.shapeId, row.entity, row.rowId, reason],
    );
  }

  /** Identity, epoch and catalog checks shared by single-shot and windowed bootstrap. */
  private validateHeader(header: ReplicaBootstrapHeader): Map<string, ReplicaEntitySchema> {
    if (header.protocolVersion !== REPLICA_PROTOCOL_VERSION) {
      throw new ReplicaRebootstrapRequiredError('protocol-mismatch');
    }
    if (header.vaultId !== this.expectedVaultId) {
      throw new ReplicaRebootstrapRequiredError('vault-mismatch');
    }
    if (!header.schemaEpoch) throw new ReplicaProtocolError('Schema epoch is required');
    const schemas = new Map<string, ReplicaEntitySchema>();
    const shapeIds = new Set<string>();
    for (const shape of header.shapes) {
      if (!shape.shapeId || !shape.appId || !shape.purpose) {
        throw new ReplicaProtocolError('Shape identity and purpose are required');
      }
      if (shapeIds.has(shape.shapeId)) {
        throw new ReplicaProtocolError(`Duplicate shape ${shape.shapeId}`);
      }
      shapeIds.add(shape.shapeId);
      for (const schema of shape.entities) {
        validateSchema(schema);
        const key = `${shape.shapeId}\u0000${schema.entity}`;
        if (schemas.has(key)) throw new ReplicaProtocolError(`Duplicate shape entity ${key}`);
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
          `Snapshot row references unknown shape entity ${row.shapeId}/${row.entity}`,
        );
      }
      const key = `${row.shapeId}\u0000${row.entity}\u0000${row.rowId}`;
      if (rowIds.has(key)) throw new ReplicaProtocolError(`Duplicate replica row ${key}`);
      rowIds.add(key);
      this.validateRow(row, schema);
    }
  }

  private validateRow(row: ReplicaSnapshotRow, schema: ReplicaEntitySchema): void {
    if (!row.rowId) throw new ReplicaProtocolError('Replica row id is required');
    const columns = new Set(schema.columns);
    for (const field of Object.keys(row.values)) {
      if (!columns.has(field)) {
        throw new ReplicaProtocolError(`Row contains unshaped field ${schema.entity}.${field}`);
      }
      validateValue(row.values[field], `${schema.entity}.${field}`);
    }
    const primaryValue = row.values[schema.primaryKey];
    const primaryMatches =
      schema.primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY
        ? primaryValue === row.rowId
        : (typeof primaryValue === 'string' || typeof primaryValue === 'number') &&
          String(primaryValue) === row.rowId;
    if (!primaryMatches) {
      throw new ReplicaProtocolError(
        `Replica row id does not match ${schema.entity}.${schema.primaryKey}`,
      );
    }
    for (const field of row.oversizedFields ?? []) {
      if (!columns.has(field)) {
        throw new ReplicaProtocolError(`Unknown oversized field ${schema.entity}.${field}`);
      }
      if (field in row.values) {
        throw new ReplicaProtocolError(`Oversized field ${schema.entity}.${field} carried a value`);
      }
    }
  }

  private changeMismatch(meta: MetaRow, batch: ReplicaChangeBatch): RebootstrapReason | undefined {
    if (batch.protocolVersion !== REPLICA_PROTOCOL_VERSION) return 'protocol-mismatch';
    if (batch.schemaEpoch !== meta.schema_epoch) return 'schema-mismatch';
    if (batch.from.epoch !== meta.cursor_epoch || batch.to.epoch !== meta.cursor_epoch) {
      return 'epoch-mismatch';
    }
    if (batch.from.seq !== meta.cursor_seq || batch.to.seq < batch.from.seq) return 'cursor-gap';
    return undefined;
  }

  private transaction(work: () => void): void {
    this.driver.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.driver.exec('COMMIT');
    } catch (error) {
      this.driver.exec('ROLLBACK');
      throw error;
    }
  }

  private run(sql: string, bind: readonly ReplicaBindValue[] = []): void {
    this.driver.run(sql, bind);
  }

  private all<T extends object>(sql: string, bind: readonly ReplicaBindValue[] = []): T[] {
    return this.driver.all<T>(sql, bind);
  }

  private one<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = [],
  ): T | undefined {
    return this.all<T>(sql, bind)[0];
  }
}

function validateCursor(cursor: ReplicaCursor): void {
  if (!cursor.epoch || !Number.isSafeInteger(cursor.seq) || cursor.seq < 0) {
    throw new ReplicaProtocolError('Replica cursor is invalid');
  }
}

function validateSchema(schema: ReplicaEntitySchema): void {
  if (!schema.entity || !schema.primaryKey)
    throw new ReplicaProtocolError('Entity schema is invalid');
  const columns = new Set(schema.columns);
  if (
    columns.size !== schema.columns.length ||
    schema.columns.some((column) => !column) ||
    !columns.has(schema.primaryKey)
  ) {
    throw new ReplicaProtocolError(`Entity ${schema.entity} has invalid columns`);
  }
  if (
    schema.hasUnavailableFields !== undefined &&
    typeof schema.hasUnavailableFields !== 'boolean'
  ) {
    throw new ReplicaProtocolError(`Entity ${schema.entity} has invalid availability metadata`);
  }
}

function validateValue(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new ReplicaProtocolError(`Replica value ${path} is not finite`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) validateValue(item, `${path}.${key}`);
    return;
  }
  throw new ReplicaProtocolError(`Replica value ${path} is not JSON-safe`);
}

function parseStringArray(value: string, label: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new ReplicaProtocolError(`Stored ${label} metadata is invalid`);
  }
  return parsed;
}

function dedupeInvalidations(values: ReplicaInvalidation[]): ReplicaInvalidation[] {
  const byKey = new Map<string, ReplicaInvalidation>();
  for (const value of values) {
    byKey.set(`${value.shapeId}\u0000${value.entity}\u0000${value.rowId ?? ''}`, value);
  }
  return [...byKey.values()];
}
