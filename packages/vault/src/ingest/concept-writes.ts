// FIND-OR-MINT over the concept vocabulary, shared by every publisher that
// files a label (#299, #996 ruling R20(d)). Its own module so the content-item
// publisher and the tag/collection publishers can both reach it without an
// import cycle between them.

import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";

export function ensureScheme(
  vault: DatabaseSync,
  uri: string,
  title: string
): string {
  const existing = vault
    .prepare("SELECT scheme_id FROM core_concept_scheme WHERE uri = ?")
    .get(uri) as { scheme_id: string } | undefined;
  if (existing) return existing.scheme_id;
  const schemeId = uuidv7();
  vault
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version)
       VALUES (?, ?, ?, 'centraid', '1')`
    )
    .run(schemeId, uri, title);
  return schemeId;
}

/**
 * A CONCEPT'S LABEL IS NOT ITS IDENTITY (#996, ruling R20(d)).
 *
 * The key a label-only scheme selects on: NFKC-normalised, whitespace
 * collapsed, case-folded, and everything else PRESERVED. `tagNotation` below
 * stripped every character outside `[a-z0-9]`, so `猫`, `犬`, `कुत्ता` and
 * `बिल्ली` all became `untitled` and selected one concept — four animals filed
 * as one idea, on every vault that does not write in Latin script.
 */
export function conceptKey(label: string): string {
  return label
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

/**
 * Resolve (or mint) the concept a label names in `schemeId`.
 *
 * Selection is on `normalized_key`, never on the slug. Rows minted before
 * [#996] carry no key, so a miss falls back to the slug ONCE and backfills the
 * key from the label it finds — migration on touch, because NFKC is not a
 * SQLite function and rung six must not guess a value it cannot compute.
 *
 * The slug keeps `UNIQUE (scheme_id, notation)`, so two labels that flatten to
 * the same ASCII get a SUFFIX rather than a shared row.
 */
export function ensureConcept(
  vault: DatabaseSync,
  schemeId: string,
  label: string,
  options?: { lang?: string | null; stableId?: string | null }
): string {
  const key = conceptKey(label);
  const stableId = options?.stableId ?? null;
  if (stableId !== null) {
    const byStable = vault
      .prepare(
        "SELECT concept_id FROM core_concept WHERE scheme_id = ? AND stable_id = ?"
      )
      .get(schemeId, stableId) as { concept_id: string } | undefined;
    if (byStable) return byStable.concept_id;
  }
  const byKey = vault
    .prepare(
      "SELECT concept_id FROM core_concept WHERE scheme_id = ? AND normalized_key = ?"
    )
    .get(schemeId, key) as { concept_id: string } | undefined;
  if (byKey) return byKey.concept_id;
  // Pre-#996 rows: the slug was the identity, so one lookup on it keeps a
  // migrated vault from minting a duplicate for a concept it already holds.
  const legacy = vault
    .prepare(
      `SELECT concept_id, pref_label FROM core_concept
        WHERE scheme_id = ? AND notation = ? AND normalized_key IS NULL`
    )
    .get(schemeId, tagNotation(label)) as
    | { concept_id: string; pref_label: string }
    | undefined;
  if (legacy && conceptKey(legacy.pref_label) === key) {
    vault
      .prepare(
        "UPDATE core_concept SET normalized_key = ? WHERE concept_id = ?"
      )
      .run(key, legacy.concept_id);
    return legacy.concept_id;
  }
  const conceptId = uuidv7();
  vault
    .prepare(
      `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition, stable_id, normalized_key, pref_label_lang)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`
    )
    .run(
      conceptId,
      schemeId,
      freeNotation(vault, schemeId, tagNotation(label)),
      label,
      stableId,
      key,
      options?.lang ?? null
    );
  return conceptId;
}

/** The first unused slug in `schemeId`: `dog`, then `dog-2`, `dog-3`, … */
function freeNotation(
  vault: DatabaseSync,
  schemeId: string,
  slug: string
): string {
  const taken = vault.prepare(
    "SELECT 1 AS x FROM core_concept WHERE scheme_id = ? AND notation = ?"
  );
  if (!taken.get(schemeId, slug)) return slug;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${slug.slice(0, 60)}-${n}`;
    if (!taken.get(schemeId, candidate)) return candidate;
  }
  // A thousand labels flattening to one slug is a broken caller, not a name.
  throw new Error(`core.concept: no free notation for "${slug}"`);
}

/**
 * The 64-character ASCII slug. NO LONGER AN IDENTITY (#996, R20(d)) — it is
 * the display notation, and `conceptKey` is what selects a concept. Kept
 * exported while [#996] wave 0c moves its remaining callers onto the domain
 * operation.
 */
export function tagNotation(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 64) || "untitled"
  );
}
