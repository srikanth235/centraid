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
// STAMP AND VALUE MUST LAND TOGETHER. Neither function opens a transaction:
// the caller already has one open around the write of the derived value, and
// the stamp belongs INSIDE it. A stamp committed without its value would make
// the automation cursor believe the work is complete. Recognition templates
// compare their pinned model against this durable stamp before staging a new
// value; there is deliberately no vault-wide backfill selector or sweep.

import type { DatabaseSync } from "node:sqlite";

import { nowIso, uuidv7 } from "../ids.js";

export interface DerivationStamp {
  /** The entity the value describes, e.g. `media.asset`. */
  targetType: string;
  targetId: string;
  /** What was produced — `caption`, `text`, `faces`, `transcript`, … */
  variant: string;
  /** The recognition capability that ran. */
  capability: string;
  /** `"<name>@<version>"` — the key a later upgrade queries against. */
  model: string;
  /** Optional small echo of what was produced; stored as JSON. */
  payload?: unknown;
  now?: string;
}

/**
 * Record that `capability` under `model` produced this target's `variant`.
 * Re-running the same derivation REPLACES the stamp rather than adding one:
 * a target's caption has one producer at a time, and the row must always name
 * the model whose output is on disk right now.
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
         (derivation_id, target_type, target_id, variant, capability, model,
          payload_json, produced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (target_type, target_id, variant) DO UPDATE SET
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
      input.model,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.now ?? nowIso()
    );
}

/** The model stamped for one target's variant, or `null` when none has run. */
export function stampedModel(
  vault: DatabaseSync,
  input: { targetType: string; targetId: string; variant: string }
): string | null {
  const row = vault
    .prepare(
      `SELECT model FROM enrich_derivation
        WHERE target_type = ? AND target_id = ? AND variant = ?`
    )
    .get(input.targetType, input.targetId, input.variant) as
    | { model: string }
    | undefined;
  return row ? row.model : null;
}
