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
 * collapsed, case-folded, and everything else PRESERVED. The ASCII slug below
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
 * SELECTION IS ON `normalized_key`, AND ONLY ON IT (#996, ruling R20(d); drift
 * ONT-29 closed by wave 0c). Wave 0b added the key and left a fallback onto
 * the ASCII slug for rows minted before it; wave 0c removes the fallback,
 * because a slug that maps 猫, 犬, कुत्ता and बिल्ली all to `untitled` cannot be
 * consulted at all without reopening the collapse it was added to end. The
 * slug is display notation now, nothing more.
 *
 * It keeps `UNIQUE (scheme_id, notation)`, so two labels that flatten to the
 * same ASCII get a SUFFIX rather than a shared row.
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
  const conceptId = uuidv7();
  vault
    .prepare(
      `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition, stable_id, normalized_key, pref_label_lang)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`
    )
    .run(
      conceptId,
      schemeId,
      freeNotation(vault, schemeId, conceptNotation(label)),
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
 * The 64-character ASCII slug — DISPLAY NOTATION, never identity (#996,
 * R20(d), ONT-29). It was `tagNotation`, it was what selected a concept, and
 * it lowercased a label and stripped everything outside `[a-z0-9]`: 猫, 犬,
 * कुत्ता and बिल्ली all became `untitled` and shared one row. Nothing selects on
 * it now — `conceptKey` does — and `freeNotation` gives colliding slugs a
 * suffix, so two ideas that flatten to the same ASCII stay two ideas.
 */
export function conceptNotation(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 64) || "untitled"
  );
}
