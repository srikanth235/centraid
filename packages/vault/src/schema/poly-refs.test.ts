// Closure guard for the polymorphic-reference registry (issue #441 A1).
//
// The A1 bug was an UNKNOWN UNKNOWN: each polymorphic `(type, id)` mechanism
// was added by a different issue, each purge clause written for the case in
// front of its author, and nothing enumerated the set — so `consent_share`,
// `enrich_embedding` and `sync_external_entity` were simply never cleaned.
// This test closes the CLASS instead of the instances: it scans the live DDL
// of BOTH files for every `(X_type, X_id)` sibling pair and asserts each is
// either registered in POLY_REF_REGISTRY (with a cleanup policy) or listed in
// POLY_REF_EXCLUSIONS (with a documented reason). A 7th mechanism added
// without a registry entry fails here — the registry cannot silently rot.
import type { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { openVaultDb } from '../db.js';
import { POLY_REF_EXCLUSIONS, POLY_REF_REGISTRY } from './poly-refs.js';

interface DetectedPair {
  table: string;
  typeCol: string;
  idCol: string;
}

/**
 * Every `(X_type, X_id)` sibling pair in a database — a column ending `_type`
 * whose same-prefix `_id` sibling also exists. Deliberately generic: it does
 * not hard-code the known prefixes (entity/target/subject/from/to/object), so
 * a mechanism introduced under a NEW prefix (`owner_type`/`owner_id`) is still
 * caught and forced to a registry decision.
 */
function detectPolyPairs(db: DatabaseSync): DetectedPair[] {
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((r) => r.name);
  const pairs: DetectedPair[] = [];
  for (const table of tables) {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    for (const col of cols) {
      if (!col.endsWith('_type')) continue;
      const idCol = `${col.slice(0, -'_type'.length)}_id`;
      if (cols.has(idCol)) pairs.push({ table, typeCol: col, idCol });
    }
  }
  return pairs;
}

/**
 * Coincidental `(X_type, X_id)` column pairs that are NOT polymorphic
 * references — the generic scan cannot tell a logical-entity pointer from a
 * domain enum beside its own primary key. `health_vital.vital_type` is a
 * measurement-kind enum ('heart_rate','bp_systolic',…) and `vital_id` its PK;
 * no other row ever points here, so there is nothing to clean. Documented so
 * the scan stays generic (novel prefixes are still caught) without flagging
 * this shape forever.
 */
const NON_POLY_PAIRS: readonly DetectedPair[] = [
  { table: 'health_vital', typeCol: 'vital_type', idCol: 'vital_id' },
];

/** A pair is accounted for if registered, excluded, or a documented non-poly coincidence. */
function isAccounted(pair: DetectedPair): boolean {
  if (POLY_REF_EXCLUSIONS.has(pair.table)) return true;
  if (
    NON_POLY_PAIRS.some(
      (n) => n.table === pair.table && n.typeCol === pair.typeCol && n.idCol === pair.idCol,
    )
  ) {
    return true;
  }
  const entry = POLY_REF_REGISTRY.find((e) => e.table === pair.table);
  return entry?.pairs.some((p) => p.typeCol === pair.typeCol && p.idCol === pair.idCol) ?? false;
}

test('every polymorphic (type, id) pair in either file is registered or excluded', () => {
  const { vault, journal, close } = openVaultDb();
  try {
    const detected = [...detectPolyPairs(vault), ...detectPolyPairs(journal)];
    // Sanity: the scan actually finds the known mechanisms (guards against a
    // detection bug that would make the assertion below vacuously pass).
    expect(detected.length).toBeGreaterThanOrEqual(10);
    const unaccounted = detected.filter((p) => !isAccounted(p));
    expect(
      unaccounted,
      `polymorphic (type,id) pairs with no registry entry or documented exclusion:\n  ${unaccounted
        .map((p) => `${p.table}.(${p.typeCol}, ${p.idCol})`)
        .join(
          '\n  ',
        )}\nAdd each to POLY_REF_REGISTRY (with a cleanup policy) or POLY_REF_EXCLUSIONS (with a reason) in schema/poly-refs.ts.`,
    ).toEqual([]);
  } finally {
    close();
    void journal;
  }
});

test('every registered poly-ref table and its columns actually exist in the DDL', () => {
  // The inverse guard: a registry entry that names a dropped/renamed table or
  // column would make cleanupPolyRefs throw at runtime — catch it here.
  const { vault, close } = openVaultDb();
  try {
    for (const entry of POLY_REF_REGISTRY) {
      const cols = new Set(
        (
          vault.prepare(`PRAGMA table_info(${JSON.stringify(entry.table)})`).all() as {
            name: string;
          }[]
        ).map((c) => c.name),
      );
      expect(cols.size, `registry table ${entry.table} does not exist in vault.db`).toBeGreaterThan(
        0,
      );
      for (const pair of entry.pairs) {
        expect(cols.has(pair.typeCol), `${entry.table}.${pair.typeCol} missing`).toBe(true);
        expect(cols.has(pair.idCol), `${entry.table}.${pair.idCol} missing`).toBe(true);
      }
    }
  } finally {
    close();
  }
});

test('registry and exclusions are disjoint and reasons are non-empty', () => {
  for (const entry of POLY_REF_REGISTRY) {
    expect(
      POLY_REF_EXCLUSIONS.has(entry.table),
      `${entry.table} is both registered and excluded`,
    ).toBe(false);
    expect(entry.note.length, `${entry.table} registry note is empty`).toBeGreaterThan(0);
  }
  for (const [table, reason] of POLY_REF_EXCLUSIONS) {
    expect(reason.length, `${table} exclusion reason is empty`).toBeGreaterThan(0);
  }
});
