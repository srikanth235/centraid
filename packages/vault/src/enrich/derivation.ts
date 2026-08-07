// Derivation provenance (issue #724 W2): the two operations the
// `enrich_derivation` sidecar exists for — stamp what a model just produced,
// and find what a newer model must produce again.
//
// THE ASYMMETRY THIS FIXES. Derived VALUES scatter across the tables the
// ontology already has: a caption is a `knowledge_annotation`, extracted text
// is a `core_content_derivative`, a face is a `media_face_region`. None of
// them records which model produced it, so "re-derive everything the old OCR
// model wrote" had no query — only `enrich_embedding` could answer, and only
// because `model` happens to sit in its uniqueness key. The stamp gives every
// capability the same answer shape, and `supersededTargets` is that answer.
//
// STAMP AND VALUE MUST LAND TOGETHER. Neither function opens a transaction:
// the caller already has one open around the write of the derived value, and
// the stamp belongs INSIDE it. A stamp committed without its value tells the
// next sweep the work is done when nothing was produced, and no later pass
// repairs that — the target is no longer in anyone's backlog. See
// `packages/gateway/src/enrich/capability-sweep.ts`, which is the caller this
// contract is written for.
//
// SUPERSESSION IS A JS PREDICATE, NOT SQL. Whether `clip@1` is older than
// `clip@2` is `isSupersededBy` (model-id.ts), which SQLite cannot express: a
// lexicographic comparison puts `clip@10` before `clip@2`, and a row of
// ANOTHER family must come back as "not superseded" rather than "older". So
// the selector reads the candidate stamps for one (capability, variant) and
// filters them in memory, bounded by `limit` — the same bounded-pass shape
// every sweep in this repo uses.

import type { DatabaseSync } from "node:sqlite";

import { nowIso, uuidv7 } from "../ids.js";
import { isSupersededBy } from "./model-id.js";

export interface DerivationStamp {
  /** The entity the value describes, e.g. `media.media_asset`. */
  targetType: string;
  targetId: string;
  /** What was produced — `caption`, `text`, `faces`, `transcript`, … */
  variant: string;
  /** The enrichment-service capability that ran. */
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

/** One target whose stamped model has been overtaken by the one running now. */
export interface SupersededTarget {
  targetType: string;
  targetId: string;
  /** The model that produced what is on disk — older than `currentModel`. */
  model: string;
}

export interface SupersededQuery {
  capability: string;
  variant: string;
  /** The model running now; `"<name>@<version>"`. */
  currentModel: string;
  /** Narrow to one entity family; omitted means every family. */
  targetType?: string;
  /** Bounded like every sweep pass. Defaults to 100. */
  limit?: number;
}

/**
 * The backfill selector: targets this capability already derived under an
 * OLDER version of the model running now. A stamp from another model family —
 * or one that does not parse — is deliberately NOT superseded: it belongs to
 * an index this model does not own, and re-deriving over it would destroy
 * someone else's recall (see `isSupersededBy`).
 */
export function supersededTargets(
  vault: DatabaseSync,
  input: SupersededQuery
): SupersededTarget[] {
  const limit = Math.max(0, Math.trunc(input.limit ?? 100));
  if (limit === 0) return [];
  // `model <> ?` is the only filtering SQL can do honestly here; the version
  // comparison happens below, so this clause is an optimization that skips the
  // already-current rows (the overwhelming majority once a backfill lands).
  const rows = vault
    .prepare(
      `SELECT target_type, target_id, model FROM enrich_derivation
        WHERE capability = ? AND variant = ? AND model <> ?
          AND (? IS NULL OR target_type = ?)
        ORDER BY target_type, target_id`
    )
    .all(
      input.capability,
      input.variant,
      input.currentModel,
      input.targetType ?? null,
      input.targetType ?? null
    ) as unknown as {
    target_type: string;
    target_id: string;
    model: string;
  }[];
  const superseded: SupersededTarget[] = [];
  for (const row of rows) {
    if (superseded.length === limit) break;
    if (!isSupersededBy(row.model, input.currentModel)) continue;
    superseded.push({
      targetType: row.target_type,
      targetId: row.target_id,
      model: row.model,
    });
  }
  return superseded;
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
