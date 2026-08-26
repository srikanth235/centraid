// Model identity for derived rows (#721): a model id is `"<name>@<version>"`,
// a stable family plus an integer bumped when vectors change meaning, which
// makes an upgrade a BACKFILL query rather than an ALTER TABLE that
// edit-in-place `schema/enrich.ts` cannot express re-runnably.
//
// The version is an INTEGER, not a semver: the only question asked is "older
// than what runs now", and any change worth recording is a full re-derivation.
// No content-hash column belongs here either — content items dedupe on
// `sha256`, so only the MODEL changing invalidates a row.

export interface ModelId {
  name: string;
  version: number;
}

/** Keeps `@` unambiguous and the id safe unescaped in SQL, logs and URLs. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu;

export function makeModelId(name: string, version: number): string {
  if (!NAME_PATTERN.test(name))
    throw new Error(
      `model name ${JSON.stringify(name)} must be alphanumeric with . _ - and must not contain "@"`
    );
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error(`model version must be a positive integer, got ${version}`);
  return `${name}@${version}`;
}

/** `null` for anything off-convention: a foreign family, NEVER a version 0. */
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

/** Within ONE family; incomparable is a value, so a mixed index is left alone. */
export function compareModelIds(a: string, b: string): number | null {
  const left = parseModelId(a);
  const right = parseModelId(b);
  if (!left || !right || left.name !== right.name) return null;
  return left.version - right.version;
}

/** Another family is NOT superseded: overwriting an index it owns destroys recall. */
export function isSupersededBy(stored: string, current: string): boolean {
  const order = compareModelIds(stored, current);
  return order !== null && order < 0;
}
