import type { VaultDb } from "../db.js";

export { FLAGS_SCHEME_URI, STARRED_NOTATION } from "./flags.js";

export function taggedConceptId(
  db: VaultDb,
  targetType: string,
  targetId: string,
  schemeUri: string
): string | undefined {
  return (
    db.vault
      .prepare(
        `SELECT t.concept_id AS id FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_type = ? AND t.target_id = ? AND s.uri = ?`
      )
      .get(targetType, targetId, schemeUri) as { id: string } | undefined
  )?.id;
}

export function taggedNotationCount(
  db: VaultDb,
  targetType: string,
  targetId: string,
  schemeUri: string,
  notation: string
): number {
  return (
    db.vault
      .prepare(
        `SELECT count(*) AS n FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_type = ? AND t.target_id = ?
            AND s.uri = ? AND c.notation = ?`
      )
      .get(targetType, targetId, schemeUri, notation) as { n: number }
  ).n;
}
