#!/usr/bin/env node
// THE LEDGER VALIDATOR (#915 Wave 4) — `bun run lint:ledgers`.
//
// governance: allow-repo-hygiene file-size-limit (#915) one validator for four
// ledgers: splitting the section table from the rules it drives would put the
// direction of a ratchet in a different file from its enforcement, which is
// exactly the drift the merge existed to remove.
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
  deviationChanged,
  diffCoverageFloors,
  diffMinimumTests,
  diffMutationFloors,
  diffPerfBudgetNumbers,
  flattenBudgetNumbers,
} from "./test-report/ratchet-floors.mjs";

export const ROOT = path.resolve(import.meta.dirname, "..");

export const FLOORS_PATH = "tests/floors.json";
export const BUDGETS_PATH = "tests/budgets.json";
export const INVENTORY_PATH = "tests/inventory.json";
export const QUARANTINE_PATH = "tests/quarantine.json";
export const CLAIMS_PATH = "tests/claims.json";
export const ROSTER_PATH = "tests/agent-e2e-mobile/roster.json";

const [F, B, I, Q] = [
  FLOORS_PATH,
  BUDGETS_PATH,
  INVENTORY_PATH,
  QUARANTINE_PATH,
];

/**
 * Every merged section: its direction, and the file its numbers lived in
 * before #915 Wave 4 (`base`, used for the merge-base fallback; `null` when the
 * section is new or is a mirror ratcheted at its own source).
 */
export const SECTIONS = Object.freeze([
  {
    file: F,
    key: "coverage",
    direction: "up",
    base: "tests/coverage-floors.json",
  },
  {
    file: F,
    key: "mutation",
    direction: "up",
    base: "tests/mutation-floors.json",
  },
  { file: F, key: "minimumTests", direction: "mirror" },
  {
    file: B,
    key: "suiteWallClock",
    direction: "down",
    budget: "lanes",
    base: "tests/suite-wall-clock.json",
  },
  { file: B, key: "rungs", direction: "down", budget: "*" },
  {
    file: B,
    key: "qualityRigs",
    direction: "down",
    budget: "*",
    base: "tests/quality-rig-budgets.json",
  },
  { file: B, key: "experience", direction: "reference" },
  {
    file: B,
    key: "designTokenCss",
    direction: "down",
    budget: "budgets",
    base: "tests/design-token-css-budget.json",
  },
  { file: B, key: "mobileSuites", direction: "mirror" },
  {
    file: I,
    key: "skips",
    direction: "down",
    budget: "_budget",
    entries: "exceptions",
    rows: "sites",
    base: "tests/skips.json",
  },
  {
    file: I,
    key: "envRed",
    direction: "down",
    budget: "_budget",
    entries: "exceptions",
    rows: "sites",
    base: "tests/env-red.json",
  },
  {
    file: I,
    key: "sleeps",
    direction: "down",
    budget: "_budget",
    entries: "population",
    base: "tests/sleep-inventory.json",
  },
  {
    file: I,
    key: "hygiene",
    direction: "down",
    budget: "budgets",
    entries: "population",
    base: "tests/hygiene-budgets.json",
  },
  {
    file: I,
    key: "commentDensity",
    direction: "down",
    entries: "population",
    base: "tests/comment-density-ratchet.json",
  },
  { file: I, key: "naCells", direction: "reference" },
  {
    file: I,
    key: "advisory",
    direction: "register",
    entries: "exceptions",
    rows: "steps",
    base: "tests/advisory-ledger.json",
  },
  { file: Q, key: "_policy", direction: "down", budget: "*", base: Q },
  {
    file: Q,
    key: "entries",
    direction: "register",
    entries: "exceptions",
    base: Q,
  },
  {
    file: Q,
    key: "lanes",
    direction: "register",
    entries: "exceptions",
    base: "tests/lane-quarantine.json",
  },
]);

/** Read a repo-relative JSON file from the working tree, or `null`. */
export function readJson(relative, root = ROOT) {
  const abs = path.join(root, relative);
  if (!existsSync(abs)) return null;
  return JSON.parse(readFileSync(abs, "utf8"));
}

/** Read a repo-relative JSON file at a git ref, or `null` when absent there. */
export function readJsonAt(ref, relative, root = ROOT) {
  try {
    return JSON.parse(
      execFileSync("git", ["show", `${ref}:${relative}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 256 * 1024 * 1024,
      })
    );
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
export function baseSection(ref, section, root = ROOT) {
  const merged = readJsonAt(ref, section.file, root);
  if (merged && Object.hasOwn(merged, section.key)) return merged[section.key];
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
export function shapeLegacy(key, old) {
  if (key === "designTokenCss") return { budgets: old ?? {} };
  if (key === "advisory") {
    const { _comment, ...steps } = old ?? {};
    return { steps };
  }
  if (key === "_policy") return old?._policy ?? null;
  if (key === "lanes") return old?.lanes ?? {};
  if (key === "entries") return old?.entries ?? [];
  return old;
}

// ---------------------------------------------------------------- serializer

const WRAP_COLUMN = 80;

/**
 * JSON in oxfmt's shape, so a scanner's `--write` leaves a tree `format:check`
 * passes without shelling out to the formatter. `JSON.stringify(…, 2)` differs
 * from oxfmt in exactly one place: an array whose elements are all numbers is
 * FILLED (as many per line as fit in 80 columns) rather than one per line. The
 * comment-density pins are 3,600 such arrays, which is why this exists.
 * @param {unknown} value the document
 * @returns {string} the serialized document, newline-terminated
 */
export function serializeLedger(value) {
  return `${render(value, 0, 0)}\n`;
}

function render(value, indent, column) {
  const pad = " ".repeat(indent);
  const inner = " ".repeat(indent + 2);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((item) => typeof item === "number")) {
      const single = `[${value.join(", ")}]`;
      if (column + single.length <= WRAP_COLUMN) return single;
      return `[\n${fill(value.map(String), inner)}\n${pad}]`;
    }
    const items = value.map(
      (item) => `${inner}${render(item, indent + 2, inner.length)}`
    );
    return `[\n${items.join(",\n")}\n${pad}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const items = entries.map(([key, child], index) => {
      const head = `${inner}${JSON.stringify(key)}: `;
      // The trailing comma counts toward the 80-column budget, so all but the
      // last entry get one column less to fit a filled array on one line.
      const comma = index === entries.length - 1 ? 0 : 1;
      return `${head}${render(child, indent + 2, head.length + comma)}`;
    });
    return `{\n${items.join(",\n")}\n${pad}}`;
  }
  return JSON.stringify(value);
}

/** As many numbers per line as fit in 80 columns — oxfmt's array fill. */
function fill(parts, pad) {
  const lines = [];
  let line = "";
  for (const [index, part] of parts.entries()) {
    const piece = index === parts.length - 1 ? part : `${part},`;
    const next = line ? `${line} ${piece}` : `${pad}${piece}`;
    if (line && next.length > WRAP_COLUMN) {
      lines.push(line);
      line = `${pad}${piece}`;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
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
export function readLedgerSection(relative, key, root = ROOT) {
  return readJson(relative, root)?.[key] ?? null;
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
export function writeLedgerSection(relative, key, next, root = ROOT) {
  const doc = readJson(relative, root) ?? {};
  doc[key] = next;
  writeFileSync(path.join(root, relative), serializeLedger(doc));
}

// -------------------------------------------------------------------- checks

/** A deadline that is a date in the future, or a named revisit trigger. */
function deadlineErrors(label, entry, today) {
  const errors = [];
  const issue = entry?.issue;
  if (typeof issue !== "number" && typeof issue !== "string") {
    errors.push(`${label} has no issue`);
  }
  const date = entry?.expires ?? entry?.expiresAt ?? entry?.revisitBy;
  if (typeof date === "string" && ISO_DATE_ONLY.test(date)) {
    if (date < today) errors.push(`${label} expired on ${date}`);
    return errors;
  }
  // env-red rows retire on an EVENT rather than a date ("when the rig lands"),
  // which is a sharper deadline than a guessed one; it is the only substitute.
  if (
    typeof entry?.revisitTrigger === "string" &&
    entry.revisitTrigger.trim()
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
export function budgetNumbers(section, value) {
  if (!section.budget || !value || typeof value !== "object") return {};
  if (section.budget === "*") return flattenBudgetNumbers(value);
  if (section.budget === "_budget") {
    return typeof value._budget === "number" ? { _budget: value._budget } : {};
  }
  return flattenBudgetNumbers(value[section.budget]);
}

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

/** Rows a register section attributes: `sites` / `steps`, else the value itself. */
function rowsOf(section, value) {
  if (Array.isArray(value)) {
    return value.map((entry, index) => [entry?.id ?? `#${index}`, entry]);
  }
  const rows = section.rows ? (value?.[section.rows] ?? {}) : (value ?? {});
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
}) {
  const errors = [];
  /** @type {Record<string, any>} */
  const head = {};
  for (const file of [
    FLOORS_PATH,
    BUDGETS_PATH,
    INVENTORY_PATH,
    QUARANTINE_PATH,
  ]) {
    head[file] = readJson(file, root);
    if (!head[file]) errors.push(`${file} is missing from the working tree`);
  }
  if (errors.length) return { errors };

  const claims = readJson(CLAIMS_PATH, root) ?? {};
  const roster = readJson(ROSTER_PATH, root) ?? {};

  for (const section of SECTIONS) {
    const doc = head[section.file];
    const value = doc[section.key];
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
      const named = value.files ?? value.source;
      for (const target of Array.isArray(named) ? named : [named]) {
        const [file] = String(target).split("#");
        if (!existsSync(path.join(root, file))) {
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
function mirrorErrors(section, label, value, claims, roster, baseRef, root) {
  const errors = [];
  const minimum = section.key === "minimumTests";
  const want = minimum
    ? minimumTestsMirror(claims)
    : mobileSuitesMirror(roster);
  const source = minimum ? CLAIMS_PATH : ROSTER_PATH;
  const got = (minimum ? value.flows : value.suites) ?? {};
  for (const key of new Set([...Object.keys(want), ...Object.keys(got)])) {
    if (want[key] !== got[key]) {
      errors.push(
        `${label}.${key} mirrors ${source} as ${want[key] ?? "(absent)"} but reads ${got[key] ?? "(absent)"}; run \`node scripts/check-ledgers.mjs --write\``
      );
    }
  }
  if (minimum) {
    // #915 renamed tests/matrix.json to tests/claims.json; the base side falls
    // back so the rename cannot let a floor down unwatched for one merge.
    const baseClaims =
      readJsonAt(baseRef, CLAIMS_PATH, root) ??
      readJsonAt(baseRef, "tests/matrix.json", root);
    if (baseClaims) {
      errors.push(
        ...diffMinimumTests(baseClaims, claims).map(
          (line) => `${label}: ${line}`
        )
      );
    }
    return errors;
  }
  const baseSuites = mobileSuitesMirror(
    readJsonAt(baseRef, ROSTER_PATH, root) ?? {}
  );
  for (const [id, ms] of Object.entries(baseSuites)) {
    if (got[id] !== undefined && got[id] > ms) {
      errors.push(
        `${label}.${id} widened ${ms} → ${got[id]} (suite budgets are tighten-only)`
      );
    }
  }
  return errors;
}

/** `{flowId: minimumTests}` for every claims flow that declares one. */
export function minimumTestsMirror(claims) {
  const out = {};
  for (const flow of claims?.flows ?? []) {
    if (typeof flow?.minimumTests === "number")
      out[flow.id] = flow.minimumTests;
  }
  return out;
}

/** `{suiteId: budgetMs}` for every roster suite that declares one. */
export function mobileSuitesMirror(roster) {
  const out = {};
  for (const [id, suite] of Object.entries(roster?.suites ?? {})) {
    if (typeof suite?.budgetMs === "number") out[id] = suite.budgetMs;
  }
  return out;
}

/** Refresh the two derived mirrors from their sources. */
export function writeMirrors(root = ROOT) {
  const floors = readJson(FLOORS_PATH, root);
  floors.minimumTests.flows = minimumTestsMirror(readJson(CLAIMS_PATH, root));
  writeFileSync(path.join(root, FLOORS_PATH), serializeLedger(floors));
  const budgets = readJson(BUDGETS_PATH, root);
  budgets.mobileSuites.suites = mobileSuitesMirror(readJson(ROSTER_PATH, root));
  writeFileSync(path.join(root, BUDGETS_PATH), serializeLedger(budgets));
}

/** Resolve the merge base the ratchet compares against. */
export function resolveBase(explicit, root = ROOT) {
  const candidates = explicit
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
      "Lower a floor or widen a budget by EXTENDING that SECTION's approvedDeviation with the new rationale (a neighbouring section's note never waives, and mere presence never waives — #781). A mirror difference is fixed by editing the source (tests/claims.json, tests/agent-e2e-mobile/roster.json) and running `node scripts/check-ledgers.mjs --write`."
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `check-ledgers: ok — ${SECTIONS.length} sections across 4 ledgers hold against ${baseRef}\n`
  );
}

if (process.argv[1] === import.meta.filename) main();
