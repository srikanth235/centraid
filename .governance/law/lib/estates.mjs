// The three estates: which body of the repository a path belongs to (#1005).
//
// A constitution that cannot say what it governs governs nothing in
// particular. Every tracked path falls in exactly one estate, and the estate is
// what makes "this change edits the rules it is judged by" a mechanical
// question rather than a reviewer's hunch:
//
//   law        the rules themselves — the union of every pack's `lawPaths`.
//              Editing it changes what the next change is allowed to do.
//   registry   the adjudication and evidence layer — receipts, the changelog,
//              the decisions file, the quality register, the docket. Editing it
//              records what happened; it never changes what is permitted.
//   territory  everything else — the product. The thing the law is for.
//
// The classification is deliberately total and deliberately ordered: `registry`
// is tested first, because `.governance/law/docket.json` also matches the law
// glob `.governance/**` and the docket is an evidence file, not a rule.
import { globToRegExp } from "./digest.mjs";
import { readPacks } from "../eslint.config.mjs";

/**
 * The registry estate, by glob. Fixed here rather than declared in a pack:
 * these are the repository's own record-keeping surfaces, and a pack that
 * could re-declare them could quietly move its own evidence out of the estate
 * that requires it to exist.
 *
 * `.governance/law/docket.json` is reserved by #1005 and created by the docket
 * lane; naming it before it exists is what keeps it from being born as law.
 */
export const REGISTRY_PATHS = Object.freeze([
  "receipts/**",
  "CHANGELOG.md",
  "docs/decisions.md",
  "QUALITY.md",
  ".governance/law/docket.json",
]);

/** The estates, in the order a path is tested against them. */
export const ESTATES = Object.freeze(["registry", "law", "territory"]);

/**
 * Build the classifier for the packs currently installed.
 *
 * Returns a function rather than classifying eagerly because the caller has
 * thousands of paths and the glob compilation is the expensive half: #1002's
 * squash alone carries 1022 files.
 *
 * @param {string[]} [lawPaths] The law globs; defaults to the packs' union.
 * @returns {(path: string) => "law"|"registry"|"territory"} The classifier.
 */
export function estateClassifier(lawPaths) {
  const globs = lawPaths ?? readPacks().flatMap((pack) => pack.lawPaths);
  const law = globs.map(globToRegExp);
  const registry = REGISTRY_PATHS.map(globToRegExp);
  return (file) => {
    if (registry.some((matcher) => matcher.test(file))) return "registry";
    if (law.some((matcher) => matcher.test(file))) return "law";
    return "territory";
  };
}

/**
 * Tag every `{path, status}` row in a file list with its estate, in place-free
 * fashion (a new array of new rows).
 *
 * @param {{path: string, status: string}[]} rows The file list.
 * @param {(path: string) => string} classify The classifier.
 * @returns {{path: string, status: string, estate: string}[]} Tagged rows.
 */
export function tagEstates(rows, classify) {
  return rows.map((row) => ({ ...row, estate: classify(row.path) }));
}

/**
 * The distinct estates present in a tagged file list, in `ESTATES` order.
 *
 * @param {{estate: string}[]} rows Tagged rows.
 * @returns {string[]} The estates touched.
 */
export function estatesOf(rows) {
  const present = new Set(rows.map((row) => row.estate));
  return ESTATES.filter((estate) => present.has(estate));
}
