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

/**
 * `schedule.task` → `schedule_task`. The vault's own composition.
 *
 * THE EXT BAND IS THREE PARTS, NOT TWO (#1014, G8). An app's own table is
 * `ext.<appId>.<table>` and its physical is `ext_<appId>_<table>` with the
 * app id's hyphens normalised to underscores — `schema/ext.ts#extPhysical`,
 * which is the vault's own composition for that band. This replaced only the
 * FIRST dot, so `ext.gym.workout` came out as `ext_gym.workout`: every SQL
 * statement a seat built for a third-party app's table named a table that does
 * not exist. On the base-version read that failure is swallowed (a table the
 * seat's file does not have is a table with no version to capture), so an ext
 * row's write went out with no precondition at all and two members editing one
 * row overwrote each other silently.
 */
export function vaultPhysicalTable(entity: string): string {
  const ext = parseExtEntity(entity);
  if (ext) return `${ext.band}_${ext.appId.replaceAll("-", "_")}_${ext.table}`;
  return entity.replace(".", "_");
}

/** `ext.gym.workout` / `extdraft.gym.workout`, or undefined for anything else. */
function parseExtEntity(
  entity: string
): { band: "ext" | "extdraft"; appId: string; table: string } | undefined {
  const parts = entity.split(".");
  if (parts.length !== 3) return undefined;
  const [band, appId, table] = parts;
  if (band !== "ext" && band !== "extdraft") return undefined;
  if (!appId || !table) return undefined;
  return { band, appId, table };
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
  // THE EXT BAND SPLITS TWICE (#1014, G8): `ext_gym_workout` is the app `gym`'s
  // table `workout`, not an entity called `ext.gym_workout`. A screen watching
  // `ext.gym.workout` would never have been told its own rows moved. The app
  // id's own underscores are not recoverable from the physical — `my-app` and
  // `my_app` normalise to the same name — so this composes the entity the same
  // way `vaultPhysicalTable` decomposes it, and the round trip is what a seat's
  // invalidation needs to match.
  for (const band of ["ext_", "extdraft_"] as const) {
    if (!table.startsWith(band)) continue;
    const rest = table.slice(band.length);
    const underscore = rest.indexOf("_");
    if (underscore <= 0) return undefined;
    return `${band.slice(0, -1)}.${rest.slice(0, underscore)}.${rest.slice(underscore + 1)}`;
  }
  const underscore = table.indexOf("_");
  if (underscore <= 0) return undefined;
  return `${table.slice(0, underscore)}.${table.slice(underscore + 1)}`;
}
