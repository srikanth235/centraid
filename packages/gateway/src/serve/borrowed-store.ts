/*
 * The borrowed store (#726 P4 D4) — one SQLite file per COUNTERPARTY VAULT,
 * holding the rows this gateway has been LENT rather than given.
 *
 * The schema is `packages/client/src/replica/store-core.ts`'s six
 * entity-agnostic tables plus FTS5, because a borrowed scope is a replica of
 * someone else's vault and there is no second answer to "what shape does a
 * projected consent scope take on disk". The deltas from store-core, all of
 * them forced by ONE store holding MANY origins:
 *
 *  - `replica_meta` / `replica_bootstrap_progress` are keyed by `shape_id`
 *    instead of being singletons. store-core is one replica of one vault; this
 *    file is N shapes from one peer, each with its own cursor and its own
 *    half-applied-bootstrap state.
 *  - `replica_shape` grows `origin_vault_id`, `edge_id` and `lease_expires_at`
 *    (D8): a shape here is an EDGE, and an edge has a landlord and a clock.
 *  - `borrowed_blob` rides along — the `blob_custody_state` bookkeeping the
 *    viewer seat needs (borrowed-cas.ts), scoped per shape so dropping a shape
 *    can reclaim exactly the bytes nothing else still refers to.
 *  - Search is indexed from the row's own scalar values rather than the
 *    client's per-entity `REPLICA_LOCAL_SEARCH` table: the gateway does not
 *    depend on `@centraid/client`, and a borrowed scope's entity vocabulary is
 *    whatever the origin's consent scope happened to cover.
 *
 * `auto_vacuum=INCREMENTAL` and `journal_mode=DELETE` are both deliberate:
 * dropping a shape must be able to hand pages back, and "one file per
 * counterparty vault" is only literally true without a companion WAL.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  borrowedBlobCustodyOf,
  borrowedBlobsOfShape,
  borrowedExclusiveBlobs,
  borrowedResidentByteTotal,
  recordBorrowedBlob,
  setBorrowedBlobCustody,
} from "./borrowed-blob-custody.js";
import { blobRefIn } from "./borrowed-blob-ref.js";
import type { BorrowedBlobRef } from "./borrowed-blob-ref.js";
import {
  borrowedChangesSince,
  borrowedEntitySchemas,
  latestBorrowedChangeSeq,
} from "./borrowed-changes.js";
import type { BorrowedChangesPage } from "./borrowed-changes.js";
import {
  borrowedIntent,
  borrowedIntentOutcomes,
  pendingBorrowedIntents,
  queueBorrowedIntent,
  recordBorrowedIntentOutcome,
} from "./borrowed-intent.js";
import type {
  BorrowedIntentInput,
  BorrowedIntentOutcomePatch,
  BorrowedIntentRecord,
} from "./borrowed-intent.js";
import { BORROWED_DDL } from "./borrowed-schema.js";
import { searchableEntitiesOf, searchBorrowedRows } from "./borrowed-search.js";
import type { BorrowedSearchResult } from "./borrowed-search.js";
import { borrowedShapeOf } from "./borrowed-store-types.js";
import type {
  BorrowedCursor,
  BorrowedEntitySchema,
  BorrowedShape,
  BorrowedShapeRow,
} from "./borrowed-store-types.js";

export type {
  BorrowedIntentInput,
  BorrowedIntentOutcomePatch,
  BorrowedIntentRecord,
} from "./borrowed-intent.js";

export type {
  BorrowedCursor,
  BorrowedEntitySchema,
  BorrowedShape,
} from "./borrowed-store-types.js";
export type {
  BorrowedChangeEntry,
  BorrowedChangesPage,
} from "./borrowed-changes.js";

export interface BorrowedShapeInput {
  shapeId: string;
  edgeId: string;
  originVaultId: string;
  appId: string;
  purpose: string;
  schemaEpoch: string;
  leaseExpiresAt: string;
  entities: readonly BorrowedEntitySchema[];
}

export interface BorrowedRow {
  shapeId: string;
  entity: string;
  rowId: string;
  values: Record<string, unknown>;
  rowVersion?: number;
  oversizedFields?: string[];
}

export type BorrowedChange =
  | ({ op: "upsert" } & BorrowedRow)
  | { op: "delete"; shapeId: string; entity: string; rowId: string };

export type { BorrowedBlobRef } from "./borrowed-blob-ref.js";
export type { BorrowedSearchResult } from "./borrowed-search.js";

const PROTOCOL_VERSION = 1;

export class BorrowedStore {
  private constructor(
    readonly file: string,
    private readonly db: DatabaseSync
  ) {}

  static open(file: string): BorrowedStore {
    mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    // auto_vacuum only takes on an empty database, so it must precede the DDL.
    db.exec("PRAGMA auto_vacuum=INCREMENTAL;");
    db.exec("PRAGMA journal_mode=DELETE;");
    db.exec("PRAGMA synchronous=FULL;");
    db.exec(BORROWED_DDL);
    return new BorrowedStore(file, db);
  }

  close(): void {
    this.db.close();
  }

  /** Exercised by the borrowed-CAS custody sweep and by tests.
   *  @public */
  get handle(): DatabaseSync {
    return this.db;
  }

  shapes(): BorrowedShape[] {
    return (
      this.db
        .prepare(
          `SELECT s.*, m.cursor_epoch, m.cursor_seq
             FROM replica_shape s
             LEFT JOIN replica_meta m ON m.shape_id = s.shape_id
            ORDER BY s.shape_id`
        )
        .all() as unknown as BorrowedShapeRow[]
    ).map(borrowedShapeOf);
  }

  shapeForEdge(edgeId: string): BorrowedShape | undefined {
    const row = this.db
      .prepare(
        `SELECT s.*, m.cursor_epoch, m.cursor_seq
           FROM replica_shape s
           LEFT JOIN replica_meta m ON m.shape_id = s.shape_id
          WHERE s.edge_id = ?`
      )
      .get(edgeId) as unknown as BorrowedShapeRow | undefined;
    return row ? borrowedShapeOf(row) : undefined;
  }

  /**
   * Open a bootstrap for one edge. Any shape the edge already carried is
   * dropped first: a shape change is a REPLACEMENT, never a merge, so a
   * narrowed field mask cannot leave the widened rows behind.
   */
  beginBootstrap(input: BorrowedShapeInput): void {
    this.transaction(() => {
      const previous = this.shapeForEdge(input.edgeId);
      if (previous) this.dropShapeWithinTransaction(previous.shapeId);
      this.db
        .prepare(
          `INSERT INTO replica_shape
             (shape_id, app_id, purpose, origin_vault_id, edge_id, schema_epoch, lease_expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.shapeId,
          input.appId,
          input.purpose,
          input.originVaultId,
          input.edgeId,
          input.schemaEpoch,
          input.leaseExpiresAt
        );
      const schema = this.db.prepare(
        `INSERT INTO replica_entity_schema
           (shape_id, entity, primary_key, columns_json, has_unavailable_fields)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const entity of input.entities) {
        schema.run(
          input.shapeId,
          entity.entity,
          entity.primaryKey,
          JSON.stringify(entity.columns),
          entity.hasUnavailableFields ? 1 : 0
        );
      }
      this.db
        .prepare(
          `INSERT INTO replica_bootstrap_progress
             (shape_id, protocol_version, origin_vault_id, schema_epoch)
           VALUES (?, ?, ?, ?)`
        )
        .run(
          input.shapeId,
          PROTOCOL_VERSION,
          input.originVaultId,
          input.schemaEpoch
        );
    });
  }

  /** Apply one window of bootstrap rows. Presence without `replica_meta` is
   *  what makes a half-applied borrowed shape unmistakable after a crash. */
  applyPage(rows: readonly BorrowedRow[]): void {
    this.transaction(() => {
      for (const row of rows) this.upsert(row);
    });
  }

  commitBootstrap(shapeId: string, cursor: BorrowedCursor): void {
    const progress = this.db
      .prepare(
        `SELECT origin_vault_id, schema_epoch FROM replica_bootstrap_progress
          WHERE shape_id = ?`
      )
      .get(shapeId) as
      | { origin_vault_id: string; schema_epoch: string }
      | undefined;
    if (!progress)
      throw new Error(`no borrowed bootstrap is open for ${shapeId}`);
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO replica_meta
             (shape_id, protocol_version, origin_vault_id, cursor_epoch, cursor_seq, schema_epoch)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(shape_id) DO UPDATE SET
             cursor_epoch = excluded.cursor_epoch,
             cursor_seq = excluded.cursor_seq,
             schema_epoch = excluded.schema_epoch`
        )
        .run(
          shapeId,
          PROTOCOL_VERSION,
          progress.origin_vault_id,
          cursor.epoch,
          cursor.seq,
          progress.schema_epoch
        );
      this.db
        .prepare("DELETE FROM replica_bootstrap_progress WHERE shape_id = ?")
        .run(shapeId);
    });
  }

  applyChanges(
    shapeId: string,
    changes: readonly BorrowedChange[],
    to: BorrowedCursor
  ): void {
    this.transaction(() => {
      for (const change of changes) {
        if (change.op === "delete")
          this.deleteRow(change.shapeId, change.entity, change.rowId);
        else this.upsert(change);
      }
      this.db
        .prepare(
          `UPDATE replica_meta SET cursor_epoch = ?, cursor_seq = ?
            WHERE shape_id = ?`
        )
        .run(to.epoch, to.seq, shapeId);
    });
  }

  /** Renewal on every authenticated contact (D8) — the lease is a clock the
   *  audience winds forward only when the origin actually answers. */
  renewLease(shapeId: string, expiresAt: string): void {
    this.db
      .prepare(
        "UPDATE replica_shape SET lease_expires_at = ? WHERE shape_id = ?"
      )
      .run(expiresAt, shapeId);
  }

  /** Shapes whose lease has run out. A partitioned audience forgets on
   *  schedule without ever being told to. */
  expiredShapes(nowIso: string): BorrowedShape[] {
    return this.shapes().filter((shape) => shape.leaseExpiresAt <= nowIso);
  }

  /** See `borrowed-blob-custody.ts` — extracted to keep this file under
   *  the repo's file-size guidance. */
  recordBlob(shapeId: string, blob: BorrowedBlobRef, custody: string): void {
    recordBorrowedBlob(this.db, shapeId, blob, custody);
  }

  blobsOfShape(
    shapeId: string
  ): Array<BorrowedBlobRef & { custodyState: string }> {
    return borrowedBlobsOfShape(this.db, shapeId);
  }

  residentByteTotal(): number {
    return borrowedResidentByteTotal(this.db);
  }

  setBlobCustody(sha256: string, custody: string): void {
    setBorrowedBlobCustody(this.db, sha256, custody);
  }

  custodyOf(sha256: string): string | undefined {
    return borrowedBlobCustodyOf(this.db, sha256);
  }

  /** Shas this shape holds that NO other shape still refers to. */
  exclusiveBlobs(shapeId: string): string[] {
    return borrowedExclusiveBlobs(this.db, shapeId);
  }

  rows(shapeId: string, entity: string): BorrowedRow[] {
    return (
      this.db
        .prepare(
          `SELECT row_id, payload_json, oversized_json, server_version
             FROM replica_row WHERE shape_id = ? AND entity = ?
            ORDER BY row_id`
        )
        .all(shapeId, entity) as unknown as Array<{
        row_id: string;
        payload_json: string;
        oversized_json: string;
        server_version: number;
      }>
    ).map((row) => ({
      shapeId,
      entity,
      rowId: row.row_id,
      values: JSON.parse(row.payload_json) as Record<string, unknown>,
      oversizedFields: JSON.parse(row.oversized_json) as string[],
      ...(row.server_version > 0 ? { rowVersion: row.server_version } : {}),
    }));
  }

  rowCount(shapeId: string): number {
    return (
      this.db
        .prepare("SELECT count(*) AS n FROM replica_row WHERE shape_id = ?")
        .get(shapeId) as { n: number }
    ).n;
  }

  /** See `borrowed-changes.ts` (#726 P5) — the device route's bootstrap
   *  shape and change-log reads. */
  entitySchemas(shapeId: string): BorrowedEntitySchema[] {
    return borrowedEntitySchemas(this.db, shapeId);
  }

  latestChangeSeq(shapeId: string): number {
    return latestBorrowedChangeSeq(this.db, shapeId);
  }

  changesSince(
    shapeId: string,
    sinceSeq: number,
    limit = 500
  ): BorrowedChangesPage {
    return borrowedChangesSince(this.db, shapeId, sinceSeq, limit);
  }

  /** See `borrowed-search.ts` — extracted to keep this file under the
   *  repo's file-size guidance. Entities this shape's OWN field mask
   *  excluded a column from; `search()` refuses these (#726 P4 D10). */
  searchableEntities(shapeId: string): { refused: string[] } {
    return searchableEntitiesOf(this.db, shapeId);
  }

  /** See `borrowed-search.ts`. A scope whose field mask excluded a column
   *  REFUSES rather than pretending to have searched it (#726 P4 D10). */
  search(shapeId: string, query: string, limit = 50): BorrowedSearchResult {
    return searchBorrowedRows(this.db, shapeId, query, limit);
  }

  /** See `borrowed-intent.ts` (#726 P5) — the write-back outbox for a
   *  read+act edge. */
  queueIntent(input: BorrowedIntentInput): BorrowedIntentRecord {
    return queueBorrowedIntent(this.db, input);
  }

  intent(intentId: string): BorrowedIntentRecord | undefined {
    return borrowedIntent(this.db, intentId);
  }

  pendingIntents(edgeId: string, limit = 50): BorrowedIntentRecord[] {
    return pendingBorrowedIntents(this.db, edgeId, limit);
  }

  intentOutcomes(
    edgeId: string,
    intentIds?: readonly string[]
  ): BorrowedIntentRecord[] {
    return borrowedIntentOutcomes(this.db, edgeId, intentIds);
  }

  recordIntentOutcome(
    intentId: string,
    patch: BorrowedIntentOutcomePatch
  ): BorrowedIntentRecord | undefined {
    const before = this.intent(intentId);
    const after = recordBorrowedIntentOutcome(this.db, intentId, patch);
    const changed =
      after &&
      (!before ||
        before.status !== after.status ||
        before.invocationId !== after.invocationId ||
        before.reason !== after.reason ||
        JSON.stringify(before.conflict) !== JSON.stringify(after.conflict) ||
        JSON.stringify(before.output) !== JSON.stringify(after.output));
    if (changed) {
      const shape = this.db
        .prepare(`SELECT shape_id FROM replica_shape WHERE edge_id = ?`)
        .get(after.edgeId) as { shape_id: string } | undefined;
      if (shape) {
        this.db
          .prepare(
            `INSERT INTO borrowed_change (shape_id, entity, row_id, op, changed_at)
             VALUES (?, '__centraid_intent_outcome', ?, 'delete', ?)`
          )
          .run(shape.shape_id, intentId, new Date().toISOString());
      }
    }
    return after;
  }

  /**
   * The one deletion path. Expiry, a revocation the origin signalled, and the
   * audience dropping the edge itself all land here — the FTS shadow tables
   * and the search-gap ledger are swept in the SAME transaction as the rows,
   * because an external-content-free FTS5 index does not cascade.
   */
  dropShape(shapeId: string): { rows: number; blobs: string[] } {
    let result: { rows: number; blobs: string[] } = { rows: 0, blobs: [] };
    this.transaction(() => {
      result = this.dropShapeWithinTransaction(shapeId);
    });
    // Hand the freed pages back rather than leaving another person's data
    // sitting in unallocated space we happen to own.
    this.db.exec("PRAGMA incremental_vacuum;");
    return result;
  }

  private dropShapeWithinTransaction(shapeId: string): {
    rows: number;
    blobs: string[];
  } {
    const rows = this.rowCount(shapeId);
    const blobs = this.exclusiveBlobs(shapeId);
    const edge = this.db
      .prepare(`SELECT edge_id FROM replica_shape WHERE shape_id = ?`)
      .get(shapeId) as { edge_id: string } | undefined;
    for (const sql of [
      "DELETE FROM replica_search WHERE shape_id = ?",
      "DELETE FROM replica_search_gap WHERE shape_id = ?",
      "DELETE FROM replica_row WHERE shape_id = ?",
      "DELETE FROM replica_entity_schema WHERE shape_id = ?",
      "DELETE FROM borrowed_blob WHERE shape_id = ?",
      "DELETE FROM replica_bootstrap_progress WHERE shape_id = ?",
      "DELETE FROM replica_meta WHERE shape_id = ?",
      "DELETE FROM replica_shape WHERE shape_id = ?",
      "DELETE FROM borrowed_change WHERE shape_id = ?",
    ]) {
      this.db.prepare(sql).run(shapeId);
    }
    // A gone edge can never be answered — an unsent intent's queue row would
    // otherwise sit forever with nowhere to drain to (#726 P5).
    if (edge) {
      this.db
        .prepare(
          `DELETE FROM borrowed_intent WHERE edge_id = ? AND status IN ('queued', 'sending', 'parked')`
        )
        .run(edge.edge_id);
    }
    return { rows, blobs };
  }

  private upsert(row: BorrowedRow): void {
    this.db
      .prepare(
        `INSERT INTO replica_row
           (shape_id, entity, row_id, payload_json, oversized_json, server_version)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(shape_id, entity, row_id) DO UPDATE SET
           payload_json = excluded.payload_json,
           oversized_json = excluded.oversized_json,
           server_version = excluded.server_version`
      )
      .run(
        row.shapeId,
        row.entity,
        row.rowId,
        JSON.stringify(row.values),
        JSON.stringify(row.oversizedFields ?? []),
        row.rowVersion ?? 0
      );
    this.indexRow(row);
    this.noteBlobRef(row);
    this.logChange(row.shapeId, row.entity, row.rowId, "upsert");
  }

  /** A device-tailable record of this row landing — #726 P5 device route.
   *  Unbounded like the rows themselves; swept only when the shape drops. */
  private logChange(
    shapeId: string,
    entity: string,
    rowId: string,
    op: "upsert" | "delete"
  ): void {
    this.db
      .prepare(
        `INSERT INTO borrowed_change (shape_id, entity, row_id, op, changed_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(shapeId, entity, rowId, op, new Date().toISOString());
  }

  /**
   * Register a blob a row's own columns name, if any — discovery only.
   * INSERT OR IGNORE so a sha the CAS already holds a custody decision for
   * (pulled, or reclaimed under pressure) is never reset back to "not yet
   * known"; the puller and `BorrowedCas` own every transition after this one.
   */
  private noteBlobRef(row: BorrowedRow): void {
    const ref = blobRefIn(row.entity, row.values);
    if (!ref) return;
    this.db
      .prepare(
        `INSERT INTO borrowed_blob (shape_id, sha256, rung, byte_size, custody_state, updated_at)
         VALUES (?, ?, ?, ?, 'at-origin', ?)
         ON CONFLICT(shape_id, sha256) DO NOTHING`
      )
      .run(
        row.shapeId,
        ref.sha256,
        ref.rung,
        ref.byteSize,
        new Date().toISOString()
      );
  }

  private deleteRow(shapeId: string, entity: string, rowId: string): void {
    for (const sql of [
      "DELETE FROM replica_search WHERE shape_id = ? AND entity = ? AND row_id = ?",
      "DELETE FROM replica_search_gap WHERE shape_id = ? AND entity = ? AND row_id = ?",
      "DELETE FROM replica_row WHERE shape_id = ? AND entity = ? AND row_id = ?",
    ]) {
      this.db.prepare(sql).run(shapeId, entity, rowId);
    }
    this.logChange(shapeId, entity, rowId, "delete");
  }

  private indexRow(row: BorrowedRow): void {
    this.deleteIndex(row);
    const oversized = row.oversizedFields ?? [];
    if (oversized.length > 0) {
      this.db
        .prepare(
          `INSERT INTO replica_search_gap (shape_id, entity, row_id, reason)
           VALUES (?, ?, ?, ?)`
        )
        .run(
          row.shapeId,
          row.entity,
          row.rowId,
          `oversized field ${oversized[0]}`
        );
      return;
    }
    const parts: string[] = [];
    for (const value of Object.values(row.values)) {
      if (typeof value === "string" && value.length > 0) parts.push(value);
    }
    if (parts.length === 0) return;
    this.db
      .prepare(
        "INSERT INTO replica_search(shape_id, entity, row_id, body) VALUES (?, ?, ?, ?)"
      )
      .run(row.shapeId, row.entity, row.rowId, parts.join("\n"));
  }

  private deleteIndex(row: BorrowedRow): void {
    this.db
      .prepare(
        "DELETE FROM replica_search WHERE shape_id = ? AND entity = ? AND row_id = ?"
      )
      .run(row.shapeId, row.entity, row.rowId);
    this.db
      .prepare(
        "DELETE FROM replica_search_gap WHERE shape_id = ? AND entity = ? AND row_id = ?"
      )
      .run(row.shapeId, row.entity, row.rowId);
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
