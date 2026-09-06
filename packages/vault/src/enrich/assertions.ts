// THE PREFERRED ASSERTION IS DERIVED, NOT STORED (#996, ruling R22).
//
// A machine tag and a document classification are CLAIMS, and claims disagree:
// two engine profiles may both say "beach" about one photo with different
// confidence, and the member's own tag says something a model cannot overrule.
// Storing "the" answer as a flag on one row would make the disagreement
// unreadable and the flag a second source of truth — the shape ONT-06 and
// #807 both filed. So every competing claim is a row, and WHICH ONE READS AS
// THE ANSWER is computed here, the same way `preferredDerivation` computes it,
// with the same stable tie-break.
//
// Owner first, always. A member's assertion is not a confidence to be beaten;
// it is the answer, and a model's claim about the same concept sits beside it
// as what the machine thought.

import type { DatabaseSync } from "node:sqlite";

import { BUILT_IN_PROFILE } from "./derivation.js";

/** One claim that a concept applies to a target. */
export interface ConceptAssertion {
  readonly tagId: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly conceptId: string;
  /** The member who asserted it, or `null` for a machine's claim. */
  readonly assertedByPartyId: string | null;
  readonly confidence: number | null;
  /** The `enrich_derivation` row behind a machine claim, when it has one. */
  readonly derivationId: string | null;
  /** The engine profile that produced it, resolved through the derivation. */
  readonly profile: string | null;
  /** `<name>@<version>` of the model behind it. */
  readonly model: string | null;
  /** The revision of the target the claim was made about. */
  readonly inputRevisionId: string | null;
  readonly assertedAt: string;
}

export interface AssertionQuery {
  readonly targetType: string;
  readonly targetId: string;
  /** Narrow to one concept; omitted, every concept claimed about the target. */
  readonly conceptId?: string;
  /** The profile the caller's policy points at, as `preferredDerivation` takes
   *  it. Absent means the built-in engines. */
  readonly preferredProfile?: string;
}

interface AssertionRow {
  tag_id: string;
  target_type: string;
  target_id: string;
  concept_id: string;
  tagged_by_party_id: string | null;
  confidence: number | null;
  derivation_id: string | null;
  input_revision_id: string | null;
  tagged_at: string;
  profile: string | null;
  model: string | null;
}

function toAssertion(row: AssertionRow): ConceptAssertion {
  return {
    tagId: row.tag_id,
    targetType: row.target_type,
    targetId: row.target_id,
    conceptId: row.concept_id,
    assertedByPartyId: row.tagged_by_party_id,
    confidence: row.confidence,
    derivationId: row.derivation_id,
    profile: row.profile,
    model: row.model,
    inputRevisionId: row.input_revision_id,
    assertedAt: row.tagged_at,
  };
}

/**
 * EVERY claim about the target, evidence resolved, in the order a reader
 * should prefer them: the owner's first, then the caller's profile, then the
 * built-in engines, then the rest by profile name — an arbitrary tie broken
 * STABLY, so two readers never disagree about which claim they read.
 *
 * Confidence does NOT order the list. A higher number from a profile the
 * member did not point policy at is not a better answer; it is a different
 * engine's opinion, and the list is where both are visible.
 */
export function competingAssertions(
  vault: DatabaseSync,
  query: AssertionQuery
): ConceptAssertion[] {
  const rows = vault
    .prepare(
      `SELECT t.tag_id, t.target_type, t.target_id, t.concept_id,
              t.tagged_by_party_id, t.confidence, t.derivation_id,
              t.input_revision_id, t.tagged_at,
              d.profile AS profile, d.model AS model
         FROM core_tag t
         LEFT JOIN enrich_derivation d ON d.derivation_id = t.derivation_id
        WHERE t.target_type = ? AND t.target_id = ?
          ${query.conceptId === undefined ? "" : "AND t.concept_id = ?"}
        ORDER BY
          CASE WHEN t.tagged_by_party_id IS NOT NULL THEN 0 ELSE 1 END,
          CASE COALESCE(d.profile, '')
            WHEN ? THEN 0 WHEN ? THEN 1 ELSE 2 END,
          COALESCE(d.profile, ''),
          t.tag_id`
    )
    .all(
      query.targetType,
      query.targetId,
      ...(query.conceptId === undefined ? [] : [query.conceptId]),
      query.preferredProfile ?? BUILT_IN_PROFILE,
      BUILT_IN_PROFILE
    ) as unknown as AssertionRow[];
  return rows.map(toAssertion);
}

/**
 * The claim a surface should render, or `null` when nothing is claimed. It is
 * always the head of `competingAssertions` — one ordering, one answer, and no
 * column anywhere that says "this is the one".
 */
export function preferredAssertion(
  vault: DatabaseSync,
  query: AssertionQuery & { conceptId: string }
): ConceptAssertion | null {
  return competingAssertions(vault, query)[0] ?? null;
}

/** Every concept claimed about a target, each reduced to its preferred claim.
 *  What a photo's tag row reads as, when several engines have had a look. */
export function preferredAssertions(
  vault: DatabaseSync,
  query: AssertionQuery
): ConceptAssertion[] {
  const preferred = new Map<string, ConceptAssertion>();
  for (const assertion of competingAssertions(vault, query)) {
    if (!preferred.has(assertion.conceptId)) {
      preferred.set(assertion.conceptId, assertion);
    }
  }
  return [...preferred.values()];
}
