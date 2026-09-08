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
