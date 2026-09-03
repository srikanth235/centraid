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

export function engineCascadeEntities(): Set<string> {
  return new Set(["access.app", "core.entity_revision"]);
}

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
