// Model identity for derived rows (#721): the convention that makes a
// model upgrade a BACKFILL rather than a migration.
//
// THE PROBLEM. `enrich_embedding` is keyed `UNIQUE (target_type, target_id,
// model)` and `model` is free TEXT. A deployment that swapped its embedder for
// a better one had two bad options: reuse the same `model` string, silently
// mixing two incompatible vector spaces in one index (cosine over vectors from
// different models is noise, and nothing in the row says so), or invent a new
// string by hand, which works exactly as well as everyone's hand-invented
// strings agree — "clip", "clip-v2", "CLIP ViT-B/32 (2026-03)".
//
// THE CONVENTION. A model id is `"<name>@<version>"`: a stable family name and
// a monotonically increasing integer the operator bumps when the vectors
// change meaning. That single string carries version identity, so "re-derive
// everything the old model produced" is a query over rows this module can
// parse — the ledger equivalent of `WHERE model_version < N` — and NOT an
// ALTER TABLE. That matters here specifically: `schema/enrich.ts` is a
// single-rung, edit-in-place schema where SQLite's `ADD COLUMN` cannot be
// written re-runnably, so a real `model_version` column would have cost a
// table rebuild across `media_face_region`'s live FK. A parseable key costs
// nothing and is re-runnable by construction.
//
// WHY VERSION IS AN INTEGER AND NOT A SEMVER. The only question anyone asks of
// it is "is this row older than what I run now" — a total order over one
// axis. Semver invites the question it cannot answer for a vector space:
// whether a "patch" bump left the embeddings comparable. It never does; any
// change worth recording is a full re-derivation. One integer says exactly
// that and nothing more.
//
// RE-DERIVATION IS ALREADY CONTENT-STABLE, so no content-hash column is
// needed here. Embedding rows target `(target_type, target_id)` whose content
// item carries `sha256` and dedupes on it (`core_content_item.sha256` is
// UNIQUE), so re-importing the same photograph lands on the SAME content row
// and therefore the same target — the embedding is not orphaned and not
// duplicated. Bytes that differ are a different content row and get their own
// derivation. The only thing that invalidates a row is the MODEL changing,
// which is precisely what the version in this key records.

/** A parsed model id — the family, and the version of it that ran. */
export interface ModelId {
  name: string;
  version: number;
}

/**
 * Family names are constrained so the `@` separator is unambiguous and the id
 * survives being a SQL literal, a log line, and a URL query value unescaped.
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu;

/** Build the canonical `"<name>@<version>"` key. Throws on an unusable pair. */
export function makeModelId(name: string, version: number): string {
  if (!NAME_PATTERN.test(name))
    throw new Error(
      `model name ${JSON.stringify(name)} must be alphanumeric with . _ - and must not contain "@"`
    );
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error(`model version must be a positive integer, got ${version}`);
  return `${name}@${version}`;
}

/**
 * Parse a stored `model` value, or `null` when it does not follow the
 * convention. `null` is the honest answer for a row written by hand or by a
 * build that predates this module: callers treat such a row as belonging to
 * a foreign family they must not compare against, never as version 0.
 */
export function parseModelId(id: string): ModelId | null {
  const at = id.lastIndexOf("@");
  if (at <= 0 || at === id.length - 1) return null;
  const name = id.slice(0, at);
  const version = id.slice(at + 1);
  if (!NAME_PATTERN.test(name)) return null;
  if (!/^[0-9]+$/u.test(version)) return null;
  const parsed = Number(version);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return { name, version: parsed };
}

/**
 * Order two ids of the SAME family by version: negative when `a` is older,
 * positive when newer, `0` when equal. `null` means "not comparable" — a
 * different family, or an id that does not follow the convention. Mirrors
 * `hexHamming`'s stance in similarity.ts: incomparable is a value, not an
 * error, so a mixed index degrades to "leave it alone" rather than throwing.
 */
export function compareModelIds(a: string, b: string): number | null {
  const left = parseModelId(a);
  const right = parseModelId(b);
  if (!left || !right || left.name !== right.name) return null;
  return left.version - right.version;
}

/**
 * Whether a stored row's model is an older version of the model running now —
 * the backfill predicate. A row of another family (or an unparseable one) is
 * NOT superseded: it belongs to an index this model does not own, and deleting
 * or overwriting it would destroy someone else's recall.
 */
export function isSupersededBy(stored: string, current: string): boolean {
  const order = compareModelIds(stored, current);
  return order !== null && order < 0;
}
