// DECLARED ⊇ OBSERVED for an action's `writes:`; the gate is
// `declared-writes.conformance.test.ts` (#883 D2).

import type { DatabaseSync } from "node:sqlite";

import { ENTITY_POINTERS, PARTY_POINTER_REGISTRY } from "@centraid/vault";

export function entityForPhysical(
  physical: string,
  entities: Iterable<string>
): string | undefined {
  for (const entity of entities) {
    const dot = entity.indexOf(".");
    if (dot <= 0) continue;
    if (`${entity.slice(0, dot)}_${entity.slice(dot + 1)}` === physical)
      return entity;
  }
  return undefined;
}

/**
 * What the ENGINE writes on every dispatch, whatever the action declared.
 *
 * `core.entity_revision` joined it in #916 (ruling ONT-revisions): the
 * pre-mutation snapshot moved out of seven call sites into the pipeline
 * (`gateway/revision-capture.ts`), which captures through generated triggers.
 * An action cannot declare a write it does not make.
 *
 * The audit band — `access_receipt`, `access_provenance` and the agent evidence
 * tables — is BAND-EXCLUDED from the entity registry
 * (`schema/local-tables.ts`), so a receipt write has no logical name for an
 * action to declare and never reaches `observed` in the first place; it is out
 * of the comparison by construction rather than by exemption.
 */
export function engineCascadeEntities(): Set<string> {
  return new Set(["access.app", "core.entity_revision"]);
}

// This cascade and `partyRepointEntities` are unioned per-action, never by
// default: `core_tag` is an ordinary app write and nearly every table carries a
// `core_party` FK, so a blanket union would exempt most of the product.
/** The entity-pointer tables (#916, rung ten): every `(type, id)` mechanism
 *  that is now a composite foreign key into `core_entity`. A purge cascades
 *  through them, so an action that purges writes them without declaring them. */
export function polyRefCascadeEntities(
  entities: Iterable<string>
): Set<string> {
  const all = [...entities];
  const cascade = new Set<string>();
  for (const entry of ENTITY_POINTERS) {
    const entity = entityForPhysical(entry.table, all);
    if (entity) cascade.add(entity);
  }
  return cascade;
}

export function partyRepointEntities(
  db: DatabaseSync,
  entities: Iterable<string>
): Set<string> {
  const all = [...entities];
  const cascade = new Set<string>();
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'`
    )
    .all() as { name: string }[];
  for (const { name } of tables) {
    const references = db
      .prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`)
      .all() as { table: string }[];
    if (!references.some((fk) => fk.table === "core_party")) continue;
    const entity = entityForPhysical(name, all);
    if (entity) cascade.add(entity);
  }
  // The merge walks one more set that no foreign key describes: the party
  // pointers `core_party` has no FK for. Derived from the same registry the
  // merge itself walks, so the two cannot drift.
  for (const pointer of PARTY_POINTER_REGISTRY) {
    const entity = entityForPhysical(pointer.table, all);
    if (entity) cascade.add(entity);
  }
  return cascade;
}

const WRITE_STATEMENT =
  /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+"?(?<table>[A-Za-z_][A-Za-z0-9_]*)"?/iu;

export function writeTargetOf(sql: string): string | undefined {
  return WRITE_STATEMENT.exec(sql)?.groups?.table;
}

export interface DeclaredWritesVerdict {
  undeclared: string[];
  unexercised: string[];
}

// Asymmetric: `undeclared` is the defect; `unexercised` is a missed branch.
export function conformDeclaredWrites(input: {
  declared: Iterable<string>;
  observed: Iterable<string>;
  engineCascade: ReadonlySet<string>;
}): DeclaredWritesVerdict {
  const declared = new Set(input.declared);
  const observed = new Set(input.observed);
  return {
    undeclared: [...observed]
      .filter(
        (entity) => !declared.has(entity) && !input.engineCascade.has(entity)
      )
      .sort(),
    unexercised: [...declared].filter((entity) => !observed.has(entity)).sort(),
  };
}
