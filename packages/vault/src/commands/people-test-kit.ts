/**
 * Tag-scheme read helpers shared by the People and Locker command tests.
 *
 * Both suites need to ask "what concept in scheme X is tagged on this row?",
 * and both were carrying their own copy of the three-table join plus a
 * hand-retyped `FLAGS_SCHEME_URI` string literal. A drifting copy of a scheme
 * URI is the kind of duplication that makes a test pass against the wrong
 * scheme, so the literal now comes from the module that owns it.
 */

import type { VaultDb } from '../db.js';

export { FLAGS_SCHEME_URI, STARRED_NOTATION } from './flags.js';

/** The concept of `scheme` currently tagged on `targetId`, if any. */
export function taggedConceptId(
  db: VaultDb,
  targetType: string,
  targetId: string,
  schemeUri: string,
): string | undefined {
  return (
    db.vault
      .prepare(
        `SELECT t.concept_id AS id FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_type = ? AND t.target_id = ? AND s.uri = ?`,
      )
      .get(targetType, targetId, schemeUri) as { id: string } | undefined
  )?.id;
}

/** How many tags of `notation` in `scheme` sit on `targetId` — 0 or 1 for a
 *  flag, so a count above 1 is the assertion that catches a double-write. */
export function taggedNotationCount(
  db: VaultDb,
  targetType: string,
  targetId: string,
  schemeUri: string,
  notation: string,
): number {
  return (
    db.vault
      .prepare(
        `SELECT count(*) AS n FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_type = ? AND t.target_id = ?
            AND s.uri = ? AND c.notation = ?`,
      )
      .get(targetType, targetId, schemeUri, notation) as { n: number }
  ).n;
}
