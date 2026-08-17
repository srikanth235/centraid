// Derivation provenance (issue #724 W2): the two operations the
// `enrich_derivation` sidecar exists for — stamp what a model just produced,
// and read which model currently owns a derived value.
//
// THE ASYMMETRY THIS FIXES. Derived VALUES scatter across the tables the
// ontology already has: a caption is a `knowledge_annotation`, extracted text
// is a `core_content_derivative`, a face is a `media_face_region`. None of
// them records which model produced it, so "re-derive everything the old OCR
// model wrote" had no query — only `enrich_embedding` could answer, and only
// because `model` happens to sit in its uniqueness key. The stamp gives every
// capability the same answer shape.
//
// PLURAL RESULTS, ONE READER (issue #807). A target's variant may now be
// derived by several ENGINE PROFILES at once — the built-in deterministic
// engine and an LLM profile can both hold an OCR result for the same page —
// so the stamp key carries `profile` and "which one is on disk" stops being a
// question with one answer. `preferredDerivation` is the single resolution
// helper that answers it for every consumer; anything that picks a row by
// hand becomes a second, divergent notion of "the" result the moment policy
// changes. Stamping without naming a profile still means the built-in engine,
// so a call site that never heard of profiles keeps its exact behaviour.
//
// STAMP AND VALUE MUST LAND TOGETHER. Neither function opens a transaction:
// the caller already has one open around the write of the derived value, and
// the stamp belongs INSIDE it. A stamp committed without its value would make
// the automation cursor believe the work is complete. Recognition templates
// compare their pinned model against this durable stamp before staging a new
// value; there is deliberately no vault-wide backfill selector or sweep.

import type { DatabaseSync } from "node:sqlite";

import { nowIso, uuidv7 } from "../ids.js";

/**
 * The engine profile of the bundled deterministic engines — the identity every
 * stamp written before profiles existed carries, and the one a caller that
 * names no profile keeps writing. Also the fallback rung of
 * `preferredDerivation`: a member who has not chosen anything is reading this.
 */
export const BUILT_IN_PROFILE = "built-in";

export interface DerivationStamp {
  /** The entity the value describes, e.g. `media.asset`. */
  targetType: string;
  targetId: string;
  /** What was produced — `caption`, `text`, `faces`, `transcript`, … */
  variant: string;
  /** The recognition capability that ran. */
  capability: string;
  /** The engine profile that ran it. Defaults to {@link BUILT_IN_PROFILE}. */
  profile?: string;
  /** `"<name>@<version>"` — the key a later upgrade queries against. */
  model: string;
  /** Optional small echo of what was produced; stored as JSON. */
  payload?: unknown;
  now?: string;
}

/** One stamp row, as `preferredDerivation` hands it back. */
export interface DerivationRecord {
  targetType: string;
  targetId: string;
  variant: string;
  capability: string;
  profile: string;
  model: string;
  /** The stored echo, already parsed; `null` when the producer stored none. */
  payload: unknown;
  producedAt: string;
}

/** Which stamp a consumer wants, before policy has said anything. */
export interface DerivationQuery {
  targetType: string;
  targetId: string;
  variant: string;
  /** The profile policy currently prefers, when the caller knows it. */
  preferredProfile?: string;
}

/**
 * Record that `capability`, run by `profile` under `model`, produced this
 * target's `variant`. Re-running the SAME profile REPLACES its stamp rather
 * than adding one: within a profile the row must always name the model whose
 * output is on disk right now. A different profile is a different row — plural
 * results per target are normal (issue #807), and `preferredDerivation` is how
 * a consumer picks among them.
 *
 * The caller owns the transaction — see the header.
 */
export function stampDerivation(
  vault: DatabaseSync,
  input: DerivationStamp
): void {
  vault
    .prepare(
      `INSERT INTO enrich_derivation
         (derivation_id, target_type, target_id, variant, capability, profile,
          model, payload_json, produced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (target_type, target_id, variant, profile) DO UPDATE SET
         capability = excluded.capability,
         model = excluded.model,
         payload_json = excluded.payload_json,
         produced_at = excluded.produced_at`
    )
    .run(
      uuidv7(),
      input.targetType,
      input.targetId,
      input.variant,
      input.capability,
      input.profile ?? BUILT_IN_PROFILE,
      input.model,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.now ?? nowIso()
    );
}

/**
 * The stamp a consumer should read for one target's variant: the preferred
 * profile's row when it exists, else the built-in engine's, else any other
 * profile's (lowest profile name first — an arbitrary tie is still a STABLE
 * one, so two readers never disagree about which result they are looking at).
 * `null` when nothing has derived this variant at all.
 *
 * THE ONE resolution helper. See the header for why picking a row by hand is
 * how a second, divergent notion of "the" result gets born.
 */
export function preferredDerivation(
  vault: DatabaseSync,
  input: DerivationQuery
): DerivationRecord | null {
  const row = vault
    .prepare(
      `SELECT target_type, target_id, variant, capability, profile, model,
              payload_json, produced_at
         FROM enrich_derivation
        WHERE target_type = ? AND target_id = ? AND variant = ?
        ORDER BY CASE profile WHEN ? THEN 0 WHEN ? THEN 1 ELSE 2 END, profile
        LIMIT 1`
    )
    .get(
      input.targetType,
      input.targetId,
      input.variant,
      input.preferredProfile ?? BUILT_IN_PROFILE,
      BUILT_IN_PROFILE
    ) as
    | {
        target_type: string;
        target_id: string;
        variant: string;
        capability: string;
        profile: string;
        model: string;
        payload_json: string | null;
        produced_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    targetType: row.target_type,
    targetId: row.target_id,
    variant: row.variant,
    capability: row.capability,
    profile: row.profile,
    model: row.model,
    // The DDL's `json_valid` CHECK is what makes this parse safe to do
    // unguarded — an invalid payload can never have been stored.
    payload: row.payload_json === null ? null : JSON.parse(row.payload_json),
    producedAt: row.produced_at,
  };
}

/**
 * The model stamped for one target's variant, or `null` when none has run.
 * Resolves through `preferredDerivation`, so a target with several profiles'
 * results answers with the one a consumer would actually be reading.
 */
export function stampedModel(
  vault: DatabaseSync,
  input: DerivationQuery
): string | null {
  return preferredDerivation(vault, input)?.model ?? null;
}
