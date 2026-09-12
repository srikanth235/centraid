// The law's ESLint config, DERIVED — never hand-written (#1005).
//
// Two linters must not confuse agents, so this config is deliberately narrow:
// it is scoped to the governance documents (the generated arrival record and
// the markdown the constitution governs) and it is never reached by
// `bun run lint`, which is oxlint over the product source. See
// docs/toolchain.md.
//
// What a rule is, and where it is enforced, is not written here either. Each
// pack under `packs/` declares its own rows — id, severity, door — and this
// file only compiles those declarations into the two configurations the two
// doors need. Adding a rule is therefore a pack edit plus a rule file; there
// is no third place to remember.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import json from "@eslint/json";
import markdown from "@eslint/markdown";

import { DOORS } from "./lib/rule.ts";
import { isRecord } from "./lib/types.ts";
import type { Door, PackDeclaration, Surface } from "./lib/types.ts";
import type { Linter, Rule } from "eslint";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..", "..");

/** Where the runner writes the arrival record; the record the law lints. */
export const ARRIVAL_PATH = ".governance/law/out/arrival.json";

/** The register of standing exceptions, linted over its own shape. */
export const DOCKET_PATH = ".governance/law/docket.json";

/** The governance documents, relative to the repository root. */
export const DOCUMENT_PATTERNS = Object.freeze([
  "receipts/*.md",
  "CONSTITUTION.md",
  "docs/decisions.md",
  "CHANGELOG.md",
]);

/**
 * Read every pack declaration under `packs/`.
 *
 * @returns {{id: string, rules: Record<string, unknown>, lawPaths: string[], domains: unknown[], file: string}[]}
 *   The packs, ordered by filename so a derived config is stable.
 */
export function readPacks(): PackDeclaration[] {
  const dir = path.join(HERE, "packs");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const file = path.join(dir, name);
      const pack = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!isRecord(pack)) throw new TypeError(`${file} is not a pack object`);
      return {
        id: typeof pack.id === "string" ? pack.id : name,
        rules: isRecord(pack.rules) ? (pack.rules as PackDeclaration["rules"]) : {},
        // Per-rule options: the shell pack's overlay rows (`.governance/conf/`)
        // live here now, because a rule's configuration belongs beside the row
        // that enables it rather than in a second file with its own syntax.
        options: isRecord(pack.options) ? pack.options : {},
        lawPaths: Array.isArray(pack.lawPaths)
          ? pack.lawPaths.filter((p): p is string => typeof p === "string")
          : [],
        domains: Array.isArray(pack.domains) ? (pack.domains as PackDeclaration["domains"]) : [],
        file,
      };
    });
}

/** Where the shell directives live, for the catalog the constitution covers. */
const DIRECTIVES = "packs/srikanth235/centraid/directives";

/**
 * A GitHub heading anchor, as `docs/decisions.md` links to its own sections.
 *
 * @param {string} heading The heading text.
 * @returns {string} The anchor, without its leading `#`.
 */
export function slug(heading: string) {
  return heading
    .toLowerCase()
    .replaceAll(/[^a-z0-9 -]/gu, "")
    .trim()
    .replaceAll(/\s+/gu, "-");
}

/**
 * What `constitution-coverage` needs to judge a citation: the whole catalog of
 * enforceable things, and every anchor `docs/decisions.md` offers.
 *
 * Resolved here rather than in the rule for the same reason the clock is: a
 * rule is a pure function of one document and its options, and this config is
 * already the one place that reads the packs.
 *
 * @returns {{rules: string[], anchors: string[]}} The catalog.
 */
export function catalog() {
  const rules = new Set();
  for (const pack of readPacks()) {
    for (const [id, row] of Object.entries(pack.rules)) {
      if ((row?.severity ?? "error") !== "off") rules.add(id);
    }
  }
  // A directive written in bash is still a directive, and the constitution
  // covers the catalog rather than the implementation language.
  try {
    for (const entry of readdirSync(path.join(ROOT, ".governance", DIRECTIVES), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) rules.add(entry.name);
    }
  } catch {
    // No shell pack installed: the rule catalog is the whole catalog.
  }
  const anchors = new Set();
  try {
    const text = readFileSync(path.join(ROOT, "docs/decisions.md"), "utf8");
    for (const match of text.matchAll(/^#{2,6}\s+(?<heading>.+?)\s*$/gmu)) {
      anchors.add(`#${slug(match.groups?.heading ?? "")}`);
    }
    // A row id is a citable thing too: `**R-1005-19**` is how a ruling in a
    // decisions table is named, and it is what a principle would cite.
    for (const match of text.matchAll(/\*\*(?<id>[A-Za-z][A-Za-z0-9-]{2,})\*\*/gu)) {
      anchors.add(`#${(match.groups?.id ?? "").toLowerCase()}`);
    }
  } catch {
    // No decisions file: every decision citation will fail, which is honest.
  }
  return { rules: [...rules].sort(), anchors: [...anchors].sort() };
}

/**
 * The doors the gate register knows about.
 *
 * `scripts/ci/gate-classes.json` is the repo's existing register of what each
 * gate is and which rung enforces it. A `door` there wins over nothing and
 * loses to the pack row: the pack is the law, the register is a cross-check.
 *
 * The two registers share ONE vocabulary (`DOORS`), which is the whole reason
 * the field is worth having: "where is this answerable" is the same question
 * for a lint rule and for a test suite, and two words for one question is how
 * a gate ends up enforced in a place nobody looks. A door outside the
 * vocabulary is refused rather than ignored — a register the reader cannot
 * trust is worse than none.
 *
 * @returns {Record<string, string>} rule/gate id → door.
 */
export function readGateDoors(): Record<string, Door> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(ROOT, "scripts/ci/gate-classes.json"), "utf8")) as unknown;
  } catch {
    return {};
  }
  if (!isRecord(raw)) return {};
  const doors: Record<string, Door> = {};
  for (const [key, row] of Object.entries(raw)) {
    if (key.startsWith("_") || !isRecord(row)) continue;
    if (typeof row.door !== "string") continue;
    if (!DOORS.includes(row.door as Door)) {
      throw new Error(
        `gate-classes.json: ${key} declares door '${row.door}', which is not one of ${DOORS.join(", ")}`
      );
    }
    doors[key] = row.door as Door;
  }
  return doors;
}

/**
 * Every enabled rule, resolved from the packs and loaded from `rules/`.
 *
 * @returns {Promise<{id: string, door: string, severity: string, surface: string, rule: object}[]>}
 *   Sorted by id. A rule declared `off` is repealed and does not appear.
 */
export type LoadedRule = {
  id: string;
  door: string;
  severity: string;
  surface: Surface | string;
  options: unknown;
  rule: Rule.RuleModule & { meta?: { door?: string; surface?: string; law?: { clock?: boolean; catalog?: boolean } } };
};

export async function loadRules(): Promise<LoadedRule[]> {
  const doors = readGateDoors();
  const declared = readPacks().flatMap((pack) =>
    Object.entries(pack.rules)
      .filter(([, row]) => (row?.severity ?? "error") !== "off")
      .map(([id, row]) => ({ id, row, options: pack.options?.[id] ?? null }))
  );
  // Imported in parallel: rule modules are pure and independent of each other,
  // and a sequential await here would pay the resolver cost once per rule on
  // every commit, at the rung the whole point of is being cheap.
  const modules = await Promise.all(
    declared.map(({ id }) => import(path.join(HERE, "rules", `${id}.ts`)) as Promise<{ default: LoadedRule["rule"] }>)
  );
  const rows = declared.map(({ id, row, options }, index) => {
    const rule = modules[index]?.default;
    if (!rule) throw new Error(`law: missing default export for rule ${id}`);
    return {
      id,
      severity: row?.severity ?? "warn",
      door: row?.door ?? doors[id] ?? rule.meta?.door ?? "window",
      surface: rule.meta?.surface ?? "arrival",
      options,
      rule,
    };
  });
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows;
}

/**
 * Compile the enabled rules into a flat config for one door.
 *
 * The hook door is the fast, blocking one: only the rules that are answerable
 * from the change set alone, all at `error`. The window door is the whole law:
 * every enabled rule, with the hook rules still fatal and the rest reported as
 * warnings so a PR sees them without a red gate standing in for owner review.
 *
 * @param {"hook"|"window"} [door] Which door to build.
 * @param {object} [options] Injection points.
 * @param {object[]} [options.declared] The resolved rules; defaults to
 *   `loadRules()`. Injectable so the runner resolves the catalog once, and so
 *   a test can put a throwaway rule through the real config path.
 * @param {string} [options.arrivalPath] The record to lint, repo-relative, so
 *   a checked-in fixture goes through the same config the real record does.
 * @returns {Promise<object[]>} A flat ESLint config array.
 */
export async function buildConfig(
  door: "hook" | "window" = "window",
  options: { declared?: LoadedRule[]; arrivalPath?: string } = {}
): Promise<Linter.Config[]> {
  const { declared, arrivalPath = ARRIVAL_PATH } = options;
  const rows = (declared ?? (await loadRules())).filter((row) =>
    door === "hook" ? row.door === "hook" : true
  );
  // The one impure input any rule gets, and it arrives as an option rather
  // than as a clock the rule reads: a rule stays a pure function of one
  // document, and a test pins the date instead of racing it.
  const today = process.env.GOVERNANCE_TODAY ?? new Date().toISOString().slice(0, 10);
  // The door decides WHICH rules run; the pack row decides how loud each one
  // is. A rule the pack declares at `error` stays an error at the window door —
  // porting a blocking shell directive into a warning would be weakening the
  // policy to make a run green. A row that declares no severity warns, which is
  // the honest verdict for something only a person can settle.
  //
  // The ONE asymmetry: at the hook door every rule that runs is fatal. A hook
  // rule that cannot stop the commit is a hook rule for nothing, and the hook
  // is also the only place where the author is still holding the change and can
  // act on it. In the window a rule whose host backing the owner has not
  // confirmed reports at its declared severity instead, so the law never stands
  // in for a review that has not happened. See README.md § The two doors.
  const severityFor = (row: LoadedRule) => (door === "hook" ? "error" : (row.severity ?? "warn"));
  const injected: { catalog?: ReturnType<typeof catalog> } = {};
  const optionsFor = (row: LoadedRule) => {
    const law = row.rule?.meta?.law;
    if (!law?.clock && !law?.catalog) return row.options;
    if (law.catalog && injected.catalog === undefined) injected.catalog = catalog();
    return {
      ...(isRecord(row.options) ? row.options : {}),
      ...(law.clock ? { today } : {}),
      ...(law.catalog ? injected.catalog : {}),
    };
  };
  const rulesIn = (...surfaces: string[]) =>
    Object.fromEntries(
      rows
        .filter((row) => surfaces.includes(String(row.surface)))
        .map((row) => {
          const resolved = optionsFor(row);
          return [`law/${row.id}`, resolved ? [severityFor(row), resolved] : severityFor(row)];
        })
    );
  const plugin = {
    meta: { name: "law", version: "0.0.0" },
    rules: Object.fromEntries(rows.map((row) => [row.id, row.rule])),
  };
  return [
    {
      files: [arrivalPath],
      language: "json/json",
      plugins: { json, law: plugin },
      // A disable comment nobody needs is a standing permission slip for the
      // next diff that moves in, so an unused one is itself a finding.
      linterOptions: { reportUnusedDisableDirectives: "error" },
      rules: rulesIn("arrival", "all"),
    },
    {
      // The docket is JSON and is linted over its own shape, always — a
      // register of exceptions with a malformed row is a register nobody can
      // read, whether or not this change touched it.
      files: [DOCKET_PATH],
      language: "json/json",
      plugins: { json, law: plugin },
      linterOptions: { reportUnusedDisableDirectives: "error" },
      rules: rulesIn("all"),
    },
    {
      files: [...DOCUMENT_PATTERNS],
      language: "markdown/commonmark",
      plugins: { markdown, law: plugin },
      linterOptions: { reportUnusedDisableDirectives: "error" },
      rules: rulesIn("documents", "all"),
    },
  ] as Linter.Config[];
}

const door = process.env.GOVERNANCE_DOOR === "hook" ? "hook" : "window";
export default await buildConfig(door);
