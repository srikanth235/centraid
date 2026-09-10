// WHERE THE WALK HAS GOT TO (#1014, B2).
//
// Recent-run health answered "did the last three fires succeed?", and one
// poisoned asset made every fire succeed while doing nothing: the ordered walk
// met the same bad row, parked, and reported `ok` forever. Success is not
// progress, so this answers the other question — how much of the library this
// capability has actually derived, and when it last produced anything at all.
//
// DELIBERATELY APPROXIMATE, AND UNDEFINED WHERE IT WOULD BE A GUESS. A recipe
// whose eligible set cannot be counted cheaply returns `undefined` (unknown),
// never a fabricated denominator: health treats unknown as unknown, exactly as
// it treats a never-fired recipe.

import type { DatabaseSync } from "node:sqlite";

export interface EnrichWalkProgress {
  /** Targets already carrying this capability's stamp. */
  readonly done: number;
  /** Targets eligible for it. */
  readonly total: number;
  /** When this capability last PRODUCED something, epoch ms. */
  readonly advancedAt?: number;
}

/** The eligible-set query per recipe; absent means "not countable, say so". */
const ELIGIBLE: Readonly<Record<string, string>> = {
  faces: `SELECT count(*) AS n FROM media_asset
           WHERE deleted_at IS NULL AND kind IN ('photo', 'scan')`,
  "embed-image": `SELECT count(*) AS n FROM media_asset
           WHERE deleted_at IS NULL AND kind IN ('photo', 'scan')`,
  "photo-ocr": `SELECT count(*) AS n FROM media_asset
           WHERE deleted_at IS NULL AND kind IN ('photo', 'scan')`,
  "embed-text": `SELECT count(DISTINCT d.content_id) AS n
                   FROM core_content_derivative d
                   JOIN core_content_item i ON i.content_id = d.content_id
                  WHERE d.variant IN ('text', 'transcript')
                    AND i.deleted_at IS NULL`,
};

/** The derivation variant each recipe stamps, for the numerator. */
const VARIANT: Readonly<Record<string, string>> = {
  faces: "faces",
  "embed-image": "embedding",
  "photo-ocr": "text",
  "embed-text": "embedding",
};

export function enrichWalkProgress(
  vault: DatabaseSync,
  automationId: string
): EnrichWalkProgress | undefined {
  const eligible = ELIGIBLE[automationId];
  const variant = VARIANT[automationId];
  if (eligible === undefined || variant === undefined) return undefined;
  const total = Number(
    (vault.prepare(eligible).get() as { n: number } | undefined)?.n ?? 0
  );
  const stamped = vault
    .prepare(
      `SELECT count(*) AS n, MAX(produced_at) AS latest
         FROM enrich_derivation WHERE variant = ?`
    )
    .get(variant) as { n: number; latest: string | null } | undefined;
  const advancedAt = stamped?.latest ? Date.parse(stamped.latest) : Number.NaN;
  return {
    done: Number(stamped?.n ?? 0),
    total,
    ...(Number.isFinite(advancedAt) ? { advancedAt } : {}),
  };
}
