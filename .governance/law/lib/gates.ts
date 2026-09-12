// The gate register: which tighten-only knobs this change moved, and which way
// (#1005).
//
// "Every gate knob is tighten-only or waiver-gated" is a constitutional
// principle, and the ledger validator (`bun run lint:ledgers`) already enforces
// it number by number. What the validator cannot do is tell the law that a gate
// moved AT ALL, so that the law can ask for the ruling that authorised it. This
// module answers only that: which ledger paths this change touched, in which
// commits, and whether the numbers loosened.
//
// The direction table is the validator's own — `SECTIONS` is imported from
// `scripts/check-ledgers.ts`, which is pure data behind a `main()` guard, so
// there is exactly one place in the repo that says whether a section ratchets
// up or down. The per-number COMPARISON here is a minimal numeric-leaf diff and
// is deliberately NOT the validator's: the validator also reads waivers,
// derived mirrors and per-budget shapes, and reimplementing that would be a
// second, quieter answer to a question that already has an authority. A "gate
// moved" verdict from here is a prompt to look at `lint:ledgers`, never a
// substitute for it.
import { byteCompare } from "./digest.ts";
import { git } from "./git.ts";
import type { CommitRow, GitRange } from "./types.ts";

/**
 * Ledger paths whose movement is a governance event.
 *
 * The four merged `tests/` ledgers carry numbers and a declared direction; the
 * rest are registers whose direction no table declares, so they report
 * `unknown` — the honest answer, and still enough to demand a ruling.
 */
export const LEDGER_PATHS = Object.freeze([
  "tests/floors.json",
  "tests/budgets.json",
  "tests/inventory.json",
  "tests/quarantine.json",
  "scripts/ci/gate-classes.json",
  "oxlint.config.ts",
  "oxfmt.config.ts",
]);

/** `allowlist.txt` anywhere under `.governance/` is a gate knob too. */
const ALLOWLIST = /^\.governance\/.*allowlist\.txt$/u;

/**
 * Whether a path is a gate ledger.
 *
 * @param {string} file The repo-relative path.
 * @returns {boolean} True when the path is a ledger.
 */
export function isLedger(file: string) {
  return LEDGER_PATHS.includes(file) || ALLOWLIST.test(file);
}

/**
 * The validator's direction table, or an empty list when it cannot be read.
 *
 * A generator that crashes because a product script moved would take every rule
 * down with it, so an unreadable table degrades to `unknown` directions rather
 * than to no arrival record at all.
 *
 * @returns {Promise<{file: string, key: string, direction: string}[]>} Sections.
 */
export async function ledgerSections() {
  try {
    // Specifier is a string so this program does not typecheck scripts/ or
    // packages/*/src (tsc --listFiles must stay inside the law tree).
    const specifier = "../../../scripts/check-ledgers.ts";
    const module = (await import(specifier)) as {
      SECTIONS?: { file: string; key: string; direction: string }[];
    };
    return module.SECTIONS ?? [];
  } catch {
    return [];
  }
}

/**
 * Every number in a value, keyed by its path inside it.
 *
 * @param {unknown} value Any JSON value.
 * @param {string} [prefix] The path so far.
 * @returns {Map<string, number>} Path → number.
 */
export function numericLeaves(value: unknown, prefix: string = "") {
  const out = new Map();
  if (typeof value === "number") {
    out.set(prefix, value);
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value)) {
    for (const [path, number] of numericLeaves(child, prefix === "" ? key : `${prefix}.${key}`)) {
      out.set(path, number);
    }
  }
  return out;
}

/**
 * Judge one section's movement.
 *
 * `up` sections are floors (a number may only rise, so a fall is a widening);
 * `down` sections are ceilings (a rise is a widening). Every other declared
 * direction — mirrors, references, dated registers — has no number to compare,
 * so it is `unknown` rather than silently `narrowed`.
 *
 * @param {object} before The section at the baseline.
 * @param {object} after The section now.
 * @param {string} direction The declared direction.
 * @returns {"widened"|"narrowed"|"mixed"|"unchanged"|"unknown"} The verdict.
 */
export function judgeSection(before: Record<string, unknown>, after: Record<string, unknown>, direction: string) {
  if (direction !== "up" && direction !== "down") return "unknown";
  const baseline = numericLeaves(before);
  const current = numericLeaves(after);
  let widened = false;
  let narrowed = false;
  for (const [path, was] of baseline) {
    if (!current.has(path)) {
      // A number that disappeared is a knob that stopped being enforced.
      widened = true;
      continue;
    }
    const now = current.get(path);
    if (now === was) continue;
    const looser = direction === "up" ? now < was : now > was;
    if (looser) widened = true;
    else narrowed = true;
  }
  if (widened && narrowed) return "mixed";
  if (widened) return "widened";
  if (narrowed) return "narrowed";
  return "unchanged";
}

/**
 * Combine the per-section verdicts for one file.
 *
 * @param {string[]} verdicts The section verdicts.
 * @returns {string} The file's verdict.
 */
export function combine(verdicts: string[]) {
  if (verdicts.length === 0) return "unknown";
  const distinct = new Set(verdicts);
  distinct.delete("unchanged");
  if (distinct.size === 0) return "unchanged";
  if (distinct.size === 1) return [...distinct][0];
  if (distinct.has("widened") || distinct.has("mixed")) return "mixed";
  return "unknown";
}

/**
 * Every `approvedDeviation` note in a value, keyed by its path inside it.
 *
 * The ledger validator's waiver is a note that must have CHANGED against the
 * base (#781: presence never waives). The law does not re-adjudicate the
 * waiver — it only reports whether one moved, so a widening with neither a
 * ruling nor a fresh note is visible.
 *
 * @param {unknown} value Any JSON value.
 * @param {string} [prefix] The path so far.
 * @returns {Map<string, string>} Path → note, serialized.
 */
export function deviations(value: unknown, prefix: string = "") {
  const out = new Map();
  if (value === null || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value)) {
    const at = prefix === "" ? key : `${prefix}.${key}`;
    if (key === "approvedDeviation") out.set(at, JSON.stringify(child));
    else for (const [path, note] of deviations(child, at)) out.set(path, note);
  }
  return out;
}

/**
 * Whether any `approvedDeviation` note in a file moved.
 *
 * @param {object|null} before The file at the baseline.
 * @param {object|null} after The file now.
 * @returns {"changed"|"unchanged"|"unknown"} The verdict.
 */
export function judgeDeviation(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  if (before === null || after === null) return "unknown";
  const baseline = deviations(before);
  const current = deviations(after);
  for (const [path, note] of current) {
    if (baseline.get(path) !== note) return "changed";
  }
  return baseline.size === current.size ? "unchanged" : "changed";
}

/**
 * Read a JSON blob at a revision, or `null`.
 *
 * @param {string} rev The revision; `""` means the index.
 * @param {string} file The repo-relative path.
 * @returns {object|null} The parsed value.
 */
function jsonAt(rev: string, file: string) {
  try {
    return (JSON.parse(git(["cat-file", "blob", `${rev}:${file}`])) as unknown);
  } catch {
    return null;
  }
}

/**
 * The gate register for one change set.
 *
 * @param {object} range The resolved range.
 * @param {string[]} paths The changed law paths to consider.
 * @param {object[]} commits The commits in the range.
 * @param {boolean} staged Whether the current side is the index.
 * @returns {Promise<{path: string, commits: string[], direction: string}[]>} Sorted by path.
 */
export async function collectGates(range: GitRange, paths: string[], commits: CommitRow[], staged: boolean) {
  const ledgers = paths.filter(isLedger).sort(byteCompare);
  if (ledgers.length === 0) return [];
  const sections = await ledgerSections();
  const current = staged ? "" : range.head;
  return ledgers.map((file) => {
    const declared = sections.filter((section) => section.file === file);
    const before = jsonAt(range.base, file);
    const after = jsonAt(current, file);
    const direction =
      declared.length === 0 || before === null || after === null
        ? "unknown"
        : combine(
            declared.map((section) =>
              judgeSection(before[section.key], after[section.key], section.direction)
            )
          );
    return {
      path: file,
      commits: commits
        .filter((commit) => commit.files.some((row) => row.path === file))
        .map((commit) => commit.sha),
      direction,
      deviation:
        before === null || after === null
          ? "unknown"
          : judgeDeviation(before as Record<string, unknown>, after as Record<string, unknown>),
    };
  });
}
