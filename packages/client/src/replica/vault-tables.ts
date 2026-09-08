// THE PHYSICAL NAME OF AN ENTITY, ON A SEAT (#996, W5-D1 and R8).
//
// A seat holds the vault's own file, so a read is plain SQL over the vault's
// own tables — and a statement needs the table's real name. The vault owns that
// name (#883, ruling O-label): `resolveEntity` composes `schema_table` for
// every entity in its registry, and `schema/fts.ts` prefixes `fts_` for the
// shadow beside it.
//
// DERIVED IN ONE PLACE, PINNED IN ONE PLACE. `packages/vault` is Node-only and
// is deliberately not a dependency of this package, so the client cannot import
// the registry; what it can do is state the derivation once and pin it to the
// vault's source, which `search-parity.test.ts` does. A second copy of
// `entity.replace(".", "_")` scattered through the read paths is a second owner
// for a name that has one.

/** `schedule.task` → `schedule_task`. The vault's own composition. */
export function vaultPhysicalTable(entity: string): string {
  return entity.replace(".", "_");
}

/**
 * The tables a seat's file holds that are NOT the vault's entities.
 *
 * The seat's own bookkeeping and the log's, which the applier writes and no
 * app reads. A change notice names tables, and naming one of these as an
 * entity would invalidate a screen every time the cursor moved.
 */
const SEAT_OWN_TABLES: ReadonlySet<string> = new Set([
  "seat_state",
  "seat_outbox",
  "seat_outbox_settled",
  "replica_log",
  "replica_change",
  "replica_meta",
]);

/**
 * `schedule_task` → `schedule.task`, the inverse of {@link vaultPhysicalTable}.
 *
 * ONLY THE FIRST UNDERSCORE, because only the first one is the schema
 * separator: `media_asset_phash` is `media.asset_phash`, one entity, not two.
 * `undefined` for a table the vault does not own — the seat's own bookkeeping,
 * SQLite's internals, an FTS shadow — so a caller that is turning a change
 * notice into invalidations drops it rather than inventing an entity name for
 * it.
 */
export function vaultEntityOfTable(table: string): string | undefined {
  if (SEAT_OWN_TABLES.has(table)) return undefined;
  if (table.startsWith("sqlite_") || table.startsWith("fts_")) return undefined;
  const underscore = table.indexOf("_");
  if (underscore <= 0) return undefined;
  return `${table.slice(0, underscore)}.${table.slice(underscore + 1)}`;
}
