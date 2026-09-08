// Closure guard for the entity supertype (#916, rung ten) — the successor to
// `poly-refs.test.ts`.
//
// The A1 bug was an UNKNOWN UNKNOWN: each polymorphic `(type, id)` mechanism
// was added by a different issue, each purge clause written for the case in
// front of its author, and nothing enumerated the set — so `enrich_embedding`
// and `sync_external_entity` were simply never cleaned. Rung ten closes the
// CLASS in the engine instead of the instances in a sweep: it scans the live
// DDL of BOTH files for every `(X_type, X_id)` sibling pair and asserts each
// is either a real composite foreign key into `core_entity` or listed in
// `ENTITY_REF_EXCLUSIONS` with a reason. A fourteenth mechanism added as bare
// columns fails here — the supertype cannot silently rot back into a registry.
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import { ONTOLOGY_PACKS } from "./atlas.js";
import { ENTITY_POINTERS, ENTITY_REF_EXCLUSIONS } from "./entity-refs.js";
import { entitySupertypeMembers } from "./entity.js";
import { PARTY_POINTER_REGISTRY } from "./party-pointers.js";
import { LOCAL_TABLES, VAULT_ENTITIES } from "./tables.js";

interface DetectedPair {
  table: string;
  typeCol: string;
  idCol: string;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_delete: string;
}

function tablesOf(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    (
      db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as {
        name: string;
      }[]
    ).map((c) => c.name)
  );
}

function foreignKeysOf(db: DatabaseSync, table: string): ForeignKeyRow[] {
  return db
    .prepare(`PRAGMA foreign_key_list(${JSON.stringify(table)})`)
    .all() as unknown as ForeignKeyRow[];
}

/**
 * Every `(X_type, X_id)` sibling pair in a database — a column ending `_type`
 * whose same-prefix `_id` sibling also exists. Deliberately generic: it does
 * not hard-code the known prefixes (entity/target/subject/from/to/object), so
 * a mechanism introduced under a NEW prefix (`owner_type`/`owner_id`) is still
 * caught and forced to a decision.
 */
function detectPairs(db: DatabaseSync): DetectedPair[] {
  const pairs: DetectedPair[] = [];
  for (const table of tablesOf(db)) {
    const cols = columnsOf(db, table);
    for (const col of cols) {
      if (!col.endsWith("_type")) continue;
      const idCol = `${col.slice(0, -"_type".length)}_id`;
      if (cols.has(idCol)) pairs.push({ table, typeCol: col, idCol });
    }
  }
  return pairs;
}

/**
 * Coincidental `(X_type, X_id)` column pairs that are neither a reference nor
 * an audit value — the generic scan cannot tell a logical-entity pointer from
 * a domain enum beside its own primary key. The one live example was
 * `health_vital.vital_type`, and it left the ontology with `health.*` (#916,
 * ruling ONT-06). The list stays, empty: the shape recurs, and an empty
 * allow-list is the honest statement that nothing currently needs it.
 */
const NON_POINTER_PAIRS: readonly DetectedPair[] = [];

/** The composite key `(typeCol, idCol) -> core_entity`, or undefined. */
function compositeKey(
  db: DatabaseSync,
  pair: DetectedPair
): ForeignKeyRow[] | undefined {
  const byId = new Map<number, ForeignKeyRow[]>();
  for (const fk of foreignKeysOf(db, pair.table)) {
    byId.set(fk.id, [...(byId.get(fk.id) ?? []), fk]);
  }
  for (const group of byId.values()) {
    const sorted = [...group].sort((a, b) => a.seq - b.seq);
    if (sorted[0]?.table !== "core_entity") continue;
    if (sorted.length !== 2) continue;
    if (sorted[0].from === pair.typeCol && sorted[1]?.from === pair.idCol) {
      return sorted;
    }
  }
  return undefined;
}

describe("entity-refs", () => {
  test("every (type, id) pair in the vault is a composite key or excluded", () => {
    const { vault, close } = openVaultDb();
    try {
      const detected = detectPairs(vault).map((p) => ({ ...p, db: vault }));
      // Sanity: the scan actually finds the known mechanisms (guards against a
      // detection bug that would make the assertion below vacuously pass).
      expect(detected.length).toBeGreaterThanOrEqual(10);
      const unaccounted = detected.filter((pair) => {
        if (ENTITY_REF_EXCLUSIONS.has(pair.table)) return false;
        if (
          NON_POINTER_PAIRS.some(
            (n) =>
              n.table === pair.table &&
              n.typeCol === pair.typeCol &&
              n.idCol === pair.idCol
          )
        ) {
          return false;
        }
        return compositeKey(pair.db, pair) === undefined;
      });
      expect(
        unaccounted.map((p) => `${p.table}.(${p.typeCol}, ${p.idCol})`),
        "a (type,id) pair with neither a composite key into core_entity nor an entry in ENTITY_REF_EXCLUSIONS (schema/entity-refs.ts)"
      ).toStrictEqual([]);
    } finally {
      close();
    }
  });

  test("every declared pointer carries the key, with the cascade", () => {
    // The inverse guard: an entry naming a dropped or renamed table or column
    // would leave Browse counting dependents that cannot exist.
    const { vault, close } = openVaultDb();
    try {
      for (const pointer of ENTITY_POINTERS) {
        const cols = columnsOf(vault, pointer.table);
        expect(cols.size, `${pointer.table} does not exist`).toBeGreaterThan(0);
        for (const pair of pointer.pairs) {
          expect(
            cols.has(pair.typeCol),
            `${pointer.table}.${pair.typeCol}`
          ).toBe(true);
          expect(cols.has(pair.idCol), `${pointer.table}.${pair.idCol}`).toBe(
            true
          );
          const key = compositeKey(vault, { ...pair, table: pointer.table });
          expect(
            key?.map((fk) => `${fk.to} ${fk.on_delete}`),
            `${pointer.table}.(${pair.typeCol}, ${pair.idCol})`
          ).toStrictEqual(["entity_type CASCADE", "entity_id CASCADE"]);
        }
        expect(pointer.note.length, `${pointer.table} note`).toBeGreaterThan(0);
      }
    } finally {
      close();
    }
  });

  test("every ontology entity is a member; every projection is not", () => {
    const { vault, close } = openVaultDb();
    const violations: string[] = [];
    try {
      const members = new Map(entitySupertypeMembers());
      for (const pack of ONTOLOGY_PACKS) {
        for (const [table, declaration] of Object.entries(
          VAULT_ENTITIES[pack] ?? {}
        )) {
          const logical = `${pack}.${table}`;
          const physical = `${pack}_${table}`;
          const keys = foreignKeysOf(vault, physical);
          const supertype = keys.filter((fk) => fk.table === "core_entity");
          const membership = supertype.filter(
            (fk) => supertype.filter((s) => s.id === fk.id).length === 1
          );
          const isProjection = declaration.projectionOf !== undefined;
          const member = members.get(logical) !== undefined;
          if (member === isProjection) {
            violations.push(
              `${logical}: ${isProjection ? "declares projectionOf but is in the supertype member set" : "is an entity but not in the supertype member set"}`
            );
          }
          if (isProjection && membership.length > 0) {
            violations.push(
              `${logical} is a projection and must not be targetable, but keys its primary key into core_entity`
            );
          }
          if (!isProjection && membership.length !== 1) {
            violations.push(
              `${logical} has ${membership.length} membership keys into core_entity — an entity has exactly one`
            );
          }
          if (!isProjection && membership[0]?.on_delete !== "CASCADE") {
            violations.push(
              `${logical}'s membership key is ${membership[0]?.on_delete} — deleting the supertype row must delete the entity row`
            );
          }
          // A projection is only honest if it still hangs off its parent — its
          // own, or the supertype where the parent is polymorphic.
          const parent = declaration.projectionOf?.replace(".", "_");
          if (parent !== undefined && !keys.some((fk) => fk.table === parent)) {
            violations.push(
              `${logical} declares projectionOf ${declaration.projectionOf} but has no key into it`
            );
          }
        }
      }
      expect(violations, violations.join("\n")).toStrictEqual([]);
    } finally {
      close();
    }
  });

  test("the kind vocabulary is exactly the registry's entity set", () => {
    const { vault, close } = openVaultDb();
    try {
      const kinds = (
        vault
          .prepare("SELECT kind FROM core_entity_kind ORDER BY kind")
          .all() as { kind: string }[]
      ).map((row) => row.kind);
      expect(kinds).toStrictEqual(
        entitySupertypeMembers()
          .map(([logical]) => logical)
          .sort()
      );
      // The supertype and its vocabulary are declared machinery, not entities.
      expect(LOCAL_TABLES.has("core_entity")).toBe(true);
      expect(LOCAL_TABLES.has("core_entity_kind")).toBe(true);
    } finally {
      close();
    }
  });

  test("one name for a pointer: target_type / target_id", () => {
    // ONT-09 (#916): the mechanism had three spellings. Rung nine renamed the
    // `item_*` pair, and this is where the rule stays one line long — a
    // fourteenth mechanism calling its pointer something else fails here.
    //
    // `core_link` is the single exception and is not a naming lapse: a link
    // has two ends, and neither of them is "the target".
    const violations: string[] = [];
    for (const pointer of ENTITY_POINTERS) {
      if (pointer.table === "core_link") continue;
      for (const pair of pointer.pairs) {
        if (pair.typeCol !== "target_type" || pair.idCol !== "target_id") {
          violations.push(
            `${pointer.table}.(${pair.typeCol}, ${pair.idCol}) — a pointer is target_type/target_id (#916, ruling ONT-09)`
          );
        }
      }
    }
    expect(violations, violations.join("\n")).toStrictEqual([]);
    const link = ENTITY_POINTERS.find((e) => e.table === "core_link");
    expect(link?.pairs.map((p) => p.typeCol)).toStrictEqual([
      "from_type",
      "to_type",
    ]);
  });

  test("pointers and exclusions are disjoint and reasons are non-empty", () => {
    for (const pointer of ENTITY_POINTERS) {
      expect(
        ENTITY_REF_EXCLUSIONS.has(pointer.table),
        `${pointer.table} is both a pointer and excluded`
      ).toBe(false);
    }
    for (const [table, reason] of ENTITY_REF_EXCLUSIONS) {
      expect(
        reason.length,
        `${table} exclusion reason is empty`
      ).toBeGreaterThan(0);
    }
  });

  test("every registered party pointer exists and is still FK-less", () => {
    // Two ways an entry goes stale, and both are silent: the column is dropped
    // or renamed (the merge's UPDATE throws), or someone gives it a real
    // foreign key (the merge's FK walk now re-points it too, and this entry
    // becomes a second, redundant pass over the same rows).
    const { vault, close } = openVaultDb();
    try {
      for (const pointer of PARTY_POINTER_REGISTRY) {
        const cols = columnsOf(vault, pointer.table);
        expect(
          cols.has(pointer.column),
          `${pointer.table} does not carry ${pointer.column}`
        ).toBe(true);
        expect(
          foreignKeysOf(vault, pointer.table).filter(
            (fk) => fk.table === "core_party" && fk.from === pointer.column
          ),
          `${pointer.table}.${pointer.column} now has a core_party foreign key — the FK walk re-points it, so drop this entry`
        ).toStrictEqual([]);
        // `revoke` dates the loser shut rather than deleting it, so the table
        // has to have somewhere to write that date.
        expect(
          pointer.collision !== "revoke" || cols.has("revoked_at"),
          `${pointer.table} has no revoked_at, so a 'revoke' collision would throw`
        ).toBe(true);
        expect(
          pointer.note.length,
          `${pointer.table}.${pointer.column} note is empty`
        ).toBeGreaterThan(0);
      }
    } finally {
      close();
    }
  });
});
