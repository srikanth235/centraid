#!/usr/bin/env node
// THE LEDGER VALIDATOR (#915 Wave 4) — `bun run lint:ledgers`.
//
//
// Twenty tighten-only JSON ledgers under `tests/` became four, and the twenty
// hard-coded directions became this table. Every section declares:
//
//   direction   `up` (floors: a number may only rise) | `down` (budgets and
//               inventories: a ceiling may only fall) | `expiry` (a register of
//               dated exceptions with no number).
//   waiver      the section's OWN `approvedDeviation`. Seven per-file waiver
//               scopes merged into one file; they did NOT merge into one
//               waiver. A receipt-approved widen of a desktop cold-start
//               ceiling must never launder a coverage-floor drop that happens
//               to ride the same PR, so the waiver is read from the section
//               being widened and nowhere else (#781: presence never waives —
//               the note must have CHANGED against the base).
//   base        the path this section's numbers lived at BEFORE the merge. The
//               comparison reads `git show <base>:tests/<merged>.json` first
//               and falls back to the old path, so the very commit that
//               renamed the files cannot widen anything under cover of "the
//               base has no such file". Without the fallback every ratchet in
//               the repo would go silent for exactly one merge.
//
// WHAT THIS DOES NOT DO. The five discovery scanners (skip-inventory,
// env-red-inventory, sleep-inventory, hygiene-ratchet,
// check-comment-density-ratchet) still own their own detection and their own
// `--write`; they measure populations off the tree, which no diff-vs-base
// validator can do. This owns the shared shape: direction, waiver scope,
// issue-and-expiry, and the two DERIVED MIRRORS (`floors.minimumTests` from
// tests/claims.json, `budgets.mobileSuites` from the mobile roster), which
// `--write` refreshes and which are asserted equal here so a mirror can never
// drift from its source.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BUDGETS_PATH,
  CLAIMS_PATH,
  FLOORS_PATH,
  INVENTORY_PATH,
  JOURNEYS_PATH,
  QUARANTINE_PATH,
  ROSTER_PATH,
  SECTIONS,
} from "./check-ledgers-sections.ts";
import type { LedgerSectionSpec } from "./check-ledgers-sections.ts";
import { serializeLedger } from "./check-ledgers-serialize.ts";
import {
  deviationChanged,
  diffCoverageFloors,
  diffMinimumTests,
  diffMutationFloors,
  diffPerfBudgetNumbers,
  flattenBudgetNumbers,
} from "./test-report/ratchet-floors.ts";

export type { LedgerSectionSpec } from "./check-ledgers-sections.ts";
export {
  BUDGETS_PATH,
  CLAIMS_PATH,
  FLOORS_PATH,
  INVENTORY_PATH,
  JOURNEYS_PATH,
  QUARANTINE_PATH,
  ROSTER_PATH,
  SECTIONS,
} from "./check-ledgers-sections.ts";
export { serializeLedger } from "./check-ledgers-serialize.ts";

export const ROOT = path.resolve(import.meta.dirname, "..");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a repo-relative JSON file from the working tree, or `null`. */
export function readJson(relative: string, root = ROOT): unknown {
  const abs = path.join(root, relative);
  if (!existsSync(abs)) return null;
  return JSON.parse(readFileSync(abs, "utf8")) as unknown;
}

/** Read a repo-relative JSON file at a git ref, or `null` when absent there. */
export function readJsonAt(
  ref: string,
  relative: string,
  root = ROOT
): unknown {
  try {
    return JSON.parse(
      execFileSync("git", ["show", `${ref}:${relative}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 256 * 1024 * 1024,
      })
    ) as unknown;
  } catch {
    return null;
  }
}

/**
 * The base-side view of one section.
 *
 * The merged file first; when the base predates the merge, the section's old
 * standalone file, shaped like the section so the same comparison runs over
 * both. Returns `null` only when neither exists — a genuine first land.
 * @param {string} ref merge base ref
 * @param {{file: string, key: string, base: string|null}} section section descriptor
 * @param {string} [root] repo root
 * @returns {unknown} the section's value on the base side, or null
 */
export function baseSection(
  ref: string,
  section: LedgerSectionSpec,
  root = ROOT
): unknown {
  const merged = readJsonAt(ref, section.file, root);
  if (isRecord(merged) && Object.hasOwn(merged, section.key))
    return merged[section.key];
  if (!section.base) return null;
  const old = readJsonAt(ref, section.base, root);
  if (old === null) return null;
  return shapeLegacy(section.key, old);
}

/**
 * Reshape a pre-merge ledger file into the section shape it became, so the
 * base side and the head side are compared like for like.
 * @param {string} key section key
 * @param {any} old the parsed pre-merge file
 * @returns {unknown} the section-shaped value
 */
export function shapeLegacy(key: string, old: unknown): unknown {
  if (key === "designTokenCss") return { budgets: old ?? {} };
  if (key === "advisory") {
    const record = isRecord(old) ? old : {};
    const { _comment: _ignored, ...steps } = record;
    return { steps };
  }
  if (key === "_policy") return isRecord(old) ? (old._policy ?? null) : null;
  if (key === "lanes") return isRecord(old) ? (old.lanes ?? {}) : {};
  if (key === "entries") return isRecord(old) ? (old.entries ?? []) : [];
  return old;
}

/**
 * One section of a merged ledger, or `null` when the file or section is absent.
 * The scanners read through this rather than parsing the file themselves, so
 * the section path exists in exactly one place.
 * @param {string} relative one of the four ledger paths
 * @param {string} key section key
 * @param {string} [root] repo root
 * @returns {any} the section's value
 */
export function readLedgerSection(
  relative: string,
  key: string,
  root = ROOT
): unknown {
  const doc = readJson(relative, root);
  if (!isRecord(doc)) return null;
  return doc[key] ?? null;
}

/**
 * Replace one section of a merged ledger, preserving key order and format.
 * The five discovery scanners call this instead of writing whole files, so a
 * `--write` on one inventory cannot reformat or clobber another's section.
 * @param {string} relative one of the four ledger paths
 * @param {string} key section key
 * @param {unknown} next the section's new value
 * @param {string} [root] repo root
 */
export function writeLedgerSection(
  relative: string,
  key: string,
  next: unknown,
  root = ROOT
): void {
  const parsed = readJson(relative, root);
  const doc: Record<string, unknown> = isRecord(parsed) ? { ...parsed } : {};
  doc[key] = next;
  writeFileSync(path.join(root, relative), serializeLedger(doc));
}

// -------------------------------------------------------------------- checks

/** A deadline that is a date in the future, or a named revisit trigger. */
function deadlineErrors(
  label: string,
  entry: unknown,
  today: string
): string[] {
  const errors: string[] = [];
  const record = isRecord(entry) ? entry : {};
  const issue = record.issue;
  if (typeof issue !== "number" && typeof issue !== "string") {
    errors.push(`${label} has no issue`);
  }
  const date = record.expires ?? record.expiresAt ?? record.revisitBy;
  if (typeof date === "string" && ISO_DATE_ONLY.test(date)) {
    if (date < today) errors.push(`${label} expired on ${date}`);
    return errors;
  }
  // env-red rows retire on an EVENT rather than a date ("when the rig lands"),
  // which is a sharper deadline than a guessed one; it is the only substitute.
  if (
    typeof record.revisitTrigger === "string" &&
    record.revisitTrigger.trim()
  ) {
    return errors;
  }
  errors.push(`${label} has no expiry (expires / expiresAt / revisitTrigger)`);
  return errors;
}

/**
 * The numbers a section ratchets, flattened to `path → number`.
 *
 * Explicit per section, never "every number in the object": an inventory row
 * carries a `line` and an `issue` that are numbers and are not budgets, and
 * flattening them would ratchet a source line number into a ceiling.
 * @param {{budget?: string}} section section descriptor
 * @param {any} value the section's value on one side
 * @returns {Record<string, number>} the ratcheted numbers
 */
export function budgetNumbers(
  section: Pick<LedgerSectionSpec, "budget">,
  value: unknown
): Record<string, number> {
  if (!section.budget || !isRecord(value)) return {};
  if (section.budget === "*") return flattenBudgetNumbers(value);
  if (section.budget === "_budget") {
    return typeof value._budget === "number" ? { _budget: value._budget } : {};
  }
  return flattenBudgetNumbers(value[section.budget]);
}

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

/** Rows a register section attributes: `sites` / `steps`, else the value itself. */
function rowsOf(
  section: LedgerSectionSpec,
  value: unknown
): Array<[string, unknown]> {
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      const id =
        isRecord(entry) &&
        (typeof entry.id === "string" || typeof entry.id === "number")
          ? String(entry.id)
          : `#${index}`;
      return [id, entry];
    });
  }
  const source = section.rows
    ? isRecord(value)
      ? value[section.rows]
      : {}
    : (value ?? {});
  const rows = isRecord(source) ? source : {};
  return Object.entries(rows).filter(([key]) => !key.startsWith("_"));
}

/**
 * Every rule, over a working tree and a merge base.
 * @param {object} options options
 * @param {string} options.baseRef the merge base ref
 * @param {string} [options.root] repo root
 * @param {string} [options.today] ISO date, for expiry comparisons
 * @returns {{errors: string[]}} every failure
 */
export function checkLedgers({
  baseRef,
  root = ROOT,
  today = new Date().toISOString().slice(0, 10),
}: {
  baseRef: string;
  root?: string;
  today?: string;
}): { errors: string[] } {
  const errors: string[] = [];
  const head: Record<string, unknown> = {};
  for (const file of [
    FLOORS_PATH,
    BUDGETS_PATH,
    INVENTORY_PATH,
    QUARANTINE_PATH,
    JOURNEYS_PATH,
  ]) {
    head[file] = readJson(file, root);
    if (!head[file]) errors.push(`${file} is missing from the working tree`);
  }
  if (errors.length) return { errors };

  const claims = readJson(CLAIMS_PATH, root) ?? {};
  const roster = readJson(ROSTER_PATH, root) ?? {};

  for (const section of SECTIONS) {
    const doc = head[section.file];
    const value = isRecord(doc) ? doc[section.key] : undefined;
    const label = `${section.file}#${section.key}`;
    if (value === undefined || value === null) {
      errors.push(`${label} is missing`);
      continue;
    }
    const base = baseSection(baseRef, section, root);

    // Every named exception carries an issue and a deadline; a population
    // budget carries them on the section, because there is no row to attribute
    // a count of sleeps or a global comment share to.
    if (section.entries === "exceptions") {
      for (const [id, entry] of rowsOf(section, value)) {
        errors.push(...deadlineErrors(`${label}.${id}`, entry, today));
      }
    } else if (section.entries === "population") {
      errors.push(...deadlineErrors(label, value, today));
    }

    if (section.direction === "reference") {
      const named = isRecord(value) ? (value.files ?? value.source) : undefined;
      for (const target of Array.isArray(named) ? named : [named]) {
        const [file] = String(target).split("#");
        if (file === undefined || !existsSync(path.join(root, file))) {
          errors.push(`${label} references ${file}, which does not exist`);
        }
      }
    } else if (section.direction === "up") {
      if (!base) continue; // first land
      const diff =
        section.key === "mutation"
          ? diffMutationFloors(base, value)
          : diffCoverageFloors(base, value);
      if (diff.length && !deviationChanged(base, value)) {
        errors.push(...diff.map((line) => `${label}: ${line}`));
      }
    } else if (section.direction === "down") {
      const baseNumbers = budgetNumbers(section, base);
      if (Object.keys(baseNumbers).length === 0) continue; // first land
      const widened = diffPerfBudgetNumbers(
        baseNumbers,
        budgetNumbers(section, value),
        label
      );
      if (widened.length && !deviationChanged(base, value)) {
        errors.push(...widened);
      }
    } else if (section.direction === "mirror") {
      errors.push(
        ...mirrorErrors(section, label, value, claims, roster, baseRef, root)
      );
    }
  }
  return { errors };
}

/**
 * A derived mirror must equal its source exactly, and the source's own numbers
 * must still ratchet. `minimumTests` mirrors tests/claims.json and
 * `mobileSuites` mirrors the mobile roster; neither number is hand-typed here.
 * @param {any} section section descriptor
 * @param {string} label section label for messages
 * @param {any} value the section's value
 * @param {any} claims parsed tests/claims.json
 * @param {any} roster parsed mobile roster
 * @param {string} baseRef merge base ref
 * @param {string} root repo root
 * @returns {string[]} failures
 */
function mirrorErrors(
  section: LedgerSectionSpec,
  label: string,
  value: unknown,
  claims: unknown,
  roster: unknown,
  baseRef: string,
  root: string
): string[] {
  const errors: string[] = [];
  const minimum = section.key === "minimumTests";
  const want = minimum
    ? minimumTestsMirror(claims)
    : mobileSuitesMirror(roster);
  const source = minimum ? CLAIMS_PATH : ROSTER_PATH;
  const gotRaw = isRecord(value) ? (minimum ? value.flows : value.suites) : {};
  const got = isRecord(gotRaw)
    ? Object.fromEntries(Object.entries(gotRaw).map(([k, v]) => [k, v]))
    : {};
  for (const key of new Set([...Object.keys(want), ...Object.keys(got)])) {
    if (want[key] !== got[key]) {
      errors.push(
        `${label}.${key} mirrors ${source} as ${want[key] ?? "(absent)"} but reads ${got[key] ?? "(absent)"}; run \`node scripts/check-ledgers.ts --write\``
      );
    }
  }
  if (minimum) {
    // #915 renamed tests/matrix.json to tests/claims.json; the base side falls
    // back so the rename cannot let a floor down unwatched for one merge.
    const baseClaims =
      readJsonAt(baseRef, CLAIMS_PATH, root) ??
      readJsonAt(baseRef, "tests/matrix.json", root);
    if (isRecord(baseClaims) && isRecord(claims)) {
      errors.push(
        ...diffMinimumTests(baseClaims, claims).map(
          (line: string) => `${label}: ${line}`
        )
      );
    }
    return errors;
  }
  const baseSuites = mobileSuitesMirror(
    readJsonAt(baseRef, ROSTER_PATH, root) ?? {}
  );
  for (const [id, ms] of Object.entries(baseSuites)) {
    const headMs = got[id];
    if (typeof headMs === "number" && headMs > ms) {
      errors.push(
        `${label}.${id} widened ${ms} → ${headMs} (suite budgets are tighten-only)`
      );
    }
  }
  return errors;
}

/** `{flowId: minimumTests}` for every claims flow that declares one. */
export function minimumTestsMirror(claims: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const flows = isRecord(claims) ? claims.flows : [];
  if (!Array.isArray(flows)) return out;
  for (const flow of flows) {
    if (
      isRecord(flow) &&
      typeof flow.id === "string" &&
      typeof flow.minimumTests === "number"
    )
      out[flow.id] = flow.minimumTests;
  }
  return out;
}

/** `{suiteId: budgetMs}` for every roster suite that declares one. */
export function mobileSuitesMirror(roster: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const suites = isRecord(roster) ? roster.suites : {};
  if (!isRecord(suites)) return out;
  for (const [id, suite] of Object.entries(suites)) {
    if (isRecord(suite) && typeof suite.budgetMs === "number")
      out[id] = suite.budgetMs;
  }
  return out;
}

/** Refresh the two derived mirrors from their sources. */
export function writeMirrors(root = ROOT): void {
  const floors = readJson(FLOORS_PATH, root);
  if (!isRecord(floors) || !isRecord(floors.minimumTests)) {
    throw new Error(`${FLOORS_PATH} is missing minimumTests`);
  }
  floors.minimumTests.flows = minimumTestsMirror(readJson(CLAIMS_PATH, root));
  writeFileSync(path.join(root, FLOORS_PATH), serializeLedger(floors));
  const budgets = readJson(BUDGETS_PATH, root);
  if (!isRecord(budgets) || !isRecord(budgets.mobileSuites)) {
    throw new Error(`${BUDGETS_PATH} is missing mobileSuites`);
  }
  budgets.mobileSuites.suites = mobileSuitesMirror(readJson(ROSTER_PATH, root));
  writeFileSync(path.join(root, BUDGETS_PATH), serializeLedger(budgets));
}

/** Resolve the merge base the ratchet compares against. */
export function resolveBase(explicit: unknown, root = ROOT): string | null {
  const candidates =
    typeof explicit === "string" && explicit
      ? [explicit]
      : ["origin/main", "main", "origin/master", "master"];
  for (const ref of candidates) {
    try {
      execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
        cwd: root,
        stdio: "ignore",
      });
      return ref;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--write")) {
    writeMirrors();
    process.stdout.write("check-ledgers: mirrors refreshed\n");
    return;
  }
  const baseIndex = argv.indexOf("--base");
  const baseRef = resolveBase(baseIndex >= 0 ? argv[baseIndex + 1] : undefined);
  if (!baseRef) {
    console.error(
      "check-ledgers: no merge base found (tried origin/main, main, origin/master, master). Fetch the default branch or pass --base <ref>."
    );
    process.exitCode = 1;
    return;
  }
  const { errors } = checkLedgers({ baseRef });
  if (errors.length) {
    console.error(
      `check-ledgers: the ledgers may only tighten (base ${baseRef})`
    );
    for (const line of errors) console.error(`  - ${line}`);
    console.error(
      "Lower a floor or widen a budget by EXTENDING that SECTION's approvedDeviation with the new rationale (a neighbouring section's note never waives, and mere presence never waives — #781). A mirror difference is fixed by editing the source (tests/claims.json, tests/agent-e2e-mobile/roster.json) and running `node scripts/check-ledgers.ts --write`."
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `check-ledgers: ok — ${SECTIONS.length} sections across ${new Set(SECTIONS.map((section) => section.file)).size} ledgers hold against ${baseRef}\n`
  );
}

if (process.argv[1] === import.meta.filename) main();
