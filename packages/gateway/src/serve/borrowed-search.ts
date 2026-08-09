/*
 * `BorrowedStore.search()`'s implementation (#726 P4 D10), extracted out of
 * `borrowed-store.ts` to keep that file under the repo's file-size guidance.
 * Operates on the store's raw `DatabaseSync` handle rather than the class
 * itself — the store's `search()`/`searchableEntities()` methods are thin
 * delegates to the two functions below.
 *
 * D10's three honest states, and where each lives:
 *   - unreached scope        a caller-side fact (`lend-audience.ts`'s sync
 *                            outcomes / `search-scaffold.ts`'s `perScopeReach`)
 *   - refused (masked column) enforced HERE, at query time, and again at
 *                            mask-selection time by `lend-search-reach.ts`
 *   - row-filtered-out row   enforced by ABSENCE — see the comment on
 *                            `searchableEntities` below; there is no SQL to
 *                            write for it because there is no row to find.
 */

import type { DatabaseSync } from "node:sqlite";

import type { BorrowedRow } from "./borrowed-store.js";

/** `BorrowedStore.search()`'s answer — `rows` from every entity that WAS
 *  searched, plus the honest list of entities that were not, so a caller
 *  never mistakes a refusal for zero matches. */
export interface BorrowedSearchResult {
  rows: BorrowedRow[];
  refusedEntities: string[];
}

/**
 * Entities a shape's OWN field mask excluded a column from
 * (`replica_entity_schema.has_unavailable_fields`, set at bootstrap from the
 * origin's `hasUnavailableFields` — the same signal `lend-search-reach.ts`
 * reproduces at mask-selection time). `searchBorrowedRows` refuses these
 * rather than running a quietly degraded index.
 *
 * Row filters need no WHERE clause here at all: a row-filtered-out row never
 * crosses the wire in the first place (`lend-origin.ts`'s
 * `lendBootstrapFrame`/`lendChangesFrame` run the SAME `projectReplicaPage`
 * an app scope does), so every row a search over `shape_id = ?` can ever
 * find already passed the origin's filter. Scoping by shape id — before the
 * LIMIT, structurally, by the absence of any other row — IS the enforcement;
 * there is nothing left for a second filter to do.
 */
export function searchableEntitiesOf(
  db: DatabaseSync,
  shapeId: string
): { refused: string[] } {
  return {
    refused: (
      db
        .prepare(
          `SELECT entity FROM replica_entity_schema
            WHERE shape_id = ? AND has_unavailable_fields = 1
            ORDER BY entity`
        )
        .all(shapeId) as unknown as Array<{ entity: string }>
    ).map((row) => row.entity),
  };
}

/**
 * Search over a shape's rows. A scope whose field mask excluded a column
 * REFUSES rather than pretending to have searched it (#726 P4 D10):
 * `refusedEntities` names every entity this call did not even query, so a
 * caller renders "search cannot check X here" instead of folding a degraded
 * index into an honest-looking "no matches".
 */
export function searchBorrowedRows(
  db: DatabaseSync,
  shapeId: string,
  query: string,
  limit: number
): BorrowedSearchResult {
  const { refused: refusedEntities } = searchableEntitiesOf(db, shapeId);
  const excludeSql =
    refusedEntities.length > 0
      ? ` AND replica_search.entity NOT IN (${refusedEntities.map(() => "?").join(",")})`
      : "";
  const rows = db
    .prepare(
      `SELECT replica_search.entity AS entity, replica_search.row_id AS row_id,
              replica_row.payload_json AS payload_json,
              replica_row.oversized_json AS oversized_json
         FROM replica_search
         JOIN replica_row
           ON replica_row.shape_id = replica_search.shape_id
          AND replica_row.entity = replica_search.entity
          AND replica_row.row_id = replica_search.row_id
        WHERE replica_search MATCH ? AND replica_search.shape_id = ?${excludeSql}
        ORDER BY replica_search.rank LIMIT ?`
    )
    .all(query, shapeId, ...refusedEntities, limit) as unknown as Array<{
    entity: string;
    row_id: string;
    payload_json: string;
    oversized_json: string;
  }>;
  return {
    rows: rows.map((row) => ({
      shapeId,
      entity: row.entity,
      rowId: row.row_id,
      values: JSON.parse(row.payload_json) as Record<string, unknown>,
      oversizedFields: JSON.parse(row.oversized_json) as string[],
    })),
    refusedEntities,
  };
}
