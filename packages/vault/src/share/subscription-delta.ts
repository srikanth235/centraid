/*
 * WHAT AN INGEST HAS TO WRITE (#929). A subscription's whole point is that a
 * refreshed shape costs the audience what CHANGED, not what it holds: scrub +
 * re-project wakes every device that ever saw the album because delete-then-
 * insert is a change row per row.
 *
 * Two facts decide it. The STRUCTURE DIGEST covers everything a field update
 * cannot express — which rows the closure carries, an album's membership, a
 * folder's filing, a Tally sub-graph — so a change there is re-projection. The
 * ORIGIN ROW VERSION covers the rest: a row whose version moved and whose
 * structure did not is one `UPDATE` of its own columns.
 */

import type { DatabaseSync } from "node:sqlite";

import { sha256Hex } from "../ids.js";
import type { WireClosure, WireRow } from "./closure.js";
import type { ShareShapeFrame } from "./subscription-frame.js";
import type { SubscriptionLineageRow } from "./subscription-store.js";

/**
 * The row tables a field update can be expressed over: one physical row, one
 * primary key, and every remaining column safe to overwrite from the origin.
 *
 * `tally.group` and `locker.item` are deliberately absent. A Tally group is a
 * sub-graph (expenses, splits, settlements) whose edits are rows this table
 * cannot name, and a Locker item's sealed columns must be re-sealed under the
 * audience DEK, which is `project-household.ts`'s job and not an `UPDATE`'s.
 * Both take the re-projection path; the cost is named in the receipt.
 */
interface FieldTable {
  physical: string;
  primaryKey: string;
  /** Identity, cross-vault keys, and anything the projection remaps. */
  excluded: readonly string[];
}

const FIELD_TABLES: ReadonlyMap<string, FieldTable> = new Map([
  [
    "core.content_item",
    {
      physical: "core_content_item",
      primaryKey: "content_id",
      excluded: ["content_id", "sha256", "byte_size", "created_at"],
    },
  ],
  [
    "media.asset",
    {
      physical: "media_asset",
      primaryKey: "asset_id",
      excluded: ["asset_id", "content_id"],
    },
  ],
  [
    "core.document",
    {
      physical: "core_document",
      primaryKey: "document_id",
      excluded: ["document_id", "current_content_id", "created_at"],
    },
  ],
  [
    "core.concept",
    {
      physical: "core_concept",
      primaryKey: "concept_id",
      excluded: ["concept_id", "scheme_id", "broader_concept_id"],
    },
  ],
  [
    "core.collection",
    {
      physical: "core_collection",
      primaryKey: "collection_id",
      excluded: [
        "collection_id",
        "owner_party_id",
        "cover_content_id",
        "parent_collection_id",
      ],
    },
  ],
]);

/** The wire row for one origin item, keyed the way lineage keys it. */
function fieldRows(closure: WireClosure): Map<string, WireRow> {
  const rows = new Map<string, WireRow>();
  const put = (entity: string, id: unknown, row: object): void => {
    if (typeof id === "string" && id.length > 0)
      rows.set(`${entity} ${id}`, row as WireRow);
  };
  for (const row of closure.rows.contentItems)
    put("core.content_item", row.content_id, row);
  for (const row of closure.rows.mediaAssets)
    put("media.asset", row.asset_id, row);
  for (const row of closure.rows.documents)
    put("core.document", row.document_id, row);
  for (const folder of closure.rows.docsFolders)
    for (const concept of folder.folders)
      put("core.concept", concept.concept_id, concept);
  for (const collection of closure.rows.collections)
    put("core.collection", collection.row.collection_id, collection.row);
  return rows;
}

/**
 * Everything a field update cannot carry. Ids are in it because a row that
 * appeared or vanished is a projection, not an update; membership and the two
 * sub-graph closures are in it because their edits live in rows no `UPDATE`
 * above can name.
 */
export function shareShapeStructureDigest(closure: WireClosure): string {
  const structure = {
    items: closure.items
      .map((item) => `${item.itemType} ${item.itemId}`)
      .sort(),
    contentItems: closure.rows.contentItems.map((row) => row.content_id).sort(),
    derivatives: closure.rows.derivatives
      .map((row) => `${row.content_id} ${row.variant} ${row.sha256 ?? ""}`)
      .sort(),
    mediaAssets: closure.rows.mediaAssets
      .map((row) => `${row.asset_id} ${row.content_id}`)
      .sort(),
    documents: closure.rows.documents
      .map((row) => `${row.document_id} ${row.current_content_id}`)
      .sort(),
    docsFolders: closure.rows.docsFolders.map((folder) => ({
      folders: folder.folders
        .map(
          (row) => `${String(row.concept_id)} ${String(row.broader_concept_id)}`
        )
        .sort(),
      tags: folder.tags
        .map((row) => `${String(row.concept_id)} ${String(row.target_id)}`)
        .sort(),
    })),
    collections: closure.rows.collections.map((collection) => ({
      id: String(collection.row.collection_id),
      entries: collection.entries
        .map(
          (entry) => `${String(entry.target_type)} ${String(entry.target_id)}`
        )
        .sort(),
    })),
    // The two sub-graph closures ride whole: their edits are rows a field
    // update cannot name, so any movement re-projects.
    lockerItems: closure.rows.lockerItems,
    tallyGroups: closure.rows.tallyGroups,
    blobs: closure.blobs.map((blob) => `${blob.sha256} ${blob.rung}`).sort(),
  };
  return sha256Hex(JSON.stringify(structure));
}

export interface ShapeFieldUpdate {
  entity: string;
  /** AUDIENCE row id. */
  rowId: string;
  originItemId: string;
  originRowVersion: number;
  columns: Record<string, unknown>;
}

export type ShareShapePlan =
  | { apply: "bootstrap" }
  | { apply: "reproject"; reason: "structure-changed" | "sub-graph" }
  | { apply: "fields"; updates: readonly ShapeFieldUpdate[] };

/** node:sqlite hands INTEGER back as a number or a bigint depending on width;
 *  the wire carries numbers, so one shape decides equality. */
function comparable(value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

/**
 * The plan a refreshed shape earns.
 *
 * ORIGIN-AUTHORITATIVE, so the decision is a COMPARISON against the audience's
 * live row and not merely against the origin's row version: an audience that
 * edited a projected row holds something the origin never projected, and the
 * next pass must repair it. Comparing is what lets the same pass write nothing
 * when nothing moved and one row when one field did.
 *
 * A shape claiming any row outside `FIELD_TABLES` re-projects whole. Those are
 * the two sub-graph closures, whose edits are rows no `UPDATE` here can name,
 * so a comparison over them would report "unchanged" about rows it never read.
 */
export function planShareShapeIngest(input: {
  audience: DatabaseSync;
  frame: ShareShapeFrame;
  lineage: readonly SubscriptionLineageRow[];
  heldDigest: string | null;
}): ShareShapePlan {
  if (input.lineage.length === 0 || input.heldDigest === null)
    return { apply: "bootstrap" };
  if (shareShapeStructureDigest(input.frame.closure) !== input.heldDigest)
    return { apply: "reproject", reason: "structure-changed" };
  if (input.lineage.some((claim) => !FIELD_TABLES.has(claim.targetType)))
    return { apply: "reproject", reason: "sub-graph" };
  const rows = fieldRows(input.frame.closure);
  const versions = new Map(
    input.frame.rowVersions.map((row) => [
      `${row.entity} ${row.rowId}`,
      row.version,
    ])
  );
  const updates: ShapeFieldUpdate[] = [];
  for (const claim of input.lineage) {
    const table = FIELD_TABLES.get(claim.targetType);
    if (!table) continue;
    const key = `${claim.targetType} ${claim.originItemId}`;
    const row = rows.get(key);
    if (!row) continue;
    const columns = Object.fromEntries(
      Object.entries(row).filter(([column]) => !table.excluded.includes(column))
    );
    const names = Object.keys(columns);
    if (names.length === 0) continue;
    const held = input.audience
      .prepare(
        `SELECT ${names.map((column) => JSON.stringify(column)).join(", ")}
           FROM ${JSON.stringify(table.physical)}
          WHERE ${JSON.stringify(table.primaryKey)} = ?`
      )
      .get(claim.targetId) as Record<string, unknown> | undefined;
    if (
      held !== undefined &&
      names.every(
        (column) => comparable(held[column]) === comparable(columns[column])
      )
    )
      continue;
    updates.push({
      entity: claim.targetType,
      rowId: claim.targetId,
      originItemId: claim.originItemId,
      originRowVersion: versions.get(key) ?? claim.originRowVersion,
      columns,
    });
  }
  return { apply: "fields", updates };
}

/**
 * One `UPDATE` per changed row, inside the caller's transaction. The physical
 * table and the column names come from `FIELD_TABLES` and the row the origin
 * sent for a table that table names — never from a peer-supplied string — which
 * is what makes the interpolation safe.
 */
export function applyShareShapeFields(
  audience: DatabaseSync,
  updates: readonly ShapeFieldUpdate[]
): number {
  let applied = 0;
  for (const update of updates) {
    const table = FIELD_TABLES.get(update.entity);
    if (!table) continue;
    const columns = Object.keys(update.columns);
    const assignments = columns
      .map((column) => `${JSON.stringify(column)} = ?`)
      .join(", ");
    const changes = audience
      .prepare(
        `UPDATE ${JSON.stringify(table.physical)} SET ${assignments}
          WHERE ${JSON.stringify(table.primaryKey)} = ?`
      )
      .run(
        ...(columns.map((column) => update.columns[column]) as (
          | string
          | number
          | null
        )[]),
        update.rowId
      ).changes;
    if (Number(changes) > 0) applied += 1;
  }
  return applied;
}
