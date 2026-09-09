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

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..", "..");

/** Where the runner writes the arrival record; the only JSON the law lints. */
export const ARRIVAL_PATH = ".governance/law/out/arrival.json";

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
 * @returns {{id: string, rules: object, lawPaths: string[], domains: unknown[], file: string}[]}
 *   The packs, ordered by filename so a derived config is stable.
 */
export function readPacks() {
  const dir = path.join(HERE, "packs");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const file = path.join(dir, name);
      const pack = JSON.parse(readFileSync(file, "utf8"));
      return {
        id: pack.id,
        rules: pack.rules ?? {},
        // Per-rule options: the shell pack's overlay rows (`.governance/conf/`)
        // live here now, because a rule's configuration belongs beside the row
        // that enables it rather than in a second file with its own syntax.
        options: pack.options ?? {},
        lawPaths: pack.lawPaths ?? [],
        domains: pack.domains ?? [],
        file,
      };
    });
}

/**
 * The doors the gate register knows about.
 *
 * `scripts/ci/gate-classes.json` is the repo's existing register of what each
 * gate is and which rung enforces it. A `door` there wins over nothing and
 * loses to the pack row: the pack is the law, the register is a cross-check
 * that has not grown the field yet. Its absence is expected, not an error.
 *
 * @returns {Record<string, string>} rule/gate id → door.
 */
export function readGateDoors() {
  try {
    const raw = JSON.parse(
      readFileSync(path.join(ROOT, "scripts/ci/gate-classes.json"), "utf8")
    );
    const doors = {};
    for (const [key, row] of Object.entries(raw)) {
      if (key.startsWith("_") || typeof row !== "object" || row === null) continue;
      if (typeof row.door === "string") doors[key] = row.door;
    }
    return doors;
  } catch {
    return {};
  }
}

/**
 * Every enabled rule, resolved from the packs and loaded from `rules/`.
 *
 * @returns {Promise<{id: string, door: string, severity: string, surface: string, rule: object}[]>}
 *   Sorted by id. A rule declared `off` is repealed and does not appear.
 */
export async function loadRules() {
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
    declared.map(({ id }) => import(path.join(HERE, "rules", `${id}.mjs`)))
  );
  const rows = declared.map(({ id, row, options }, index) => {
    const rule = modules[index].default;
    return {
      id,
      severity: row?.severity ?? "warn",
      door: row?.door ?? doors[id] ?? rule?.meta?.door ?? "window",
      surface: rule?.meta?.surface ?? "arrival",
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
export async function buildConfig(door = "window", options = {}) {
  const { declared, arrivalPath = ARRIVAL_PATH } = options;
  const rows = (declared ?? (await loadRules())).filter((row) =>
    door === "hook" ? row.door === "hook" : true
  );
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
  const severityFor = (row) => (door === "hook" ? "error" : (row.severity ?? "warn"));
  const rulesFor = (surface) =>
    Object.fromEntries(
      rows
        .filter((row) => row.surface === surface)
        .map((row) => [
          `law/${row.id}`,
          row.options ? [severityFor(row), row.options] : severityFor(row),
        ])
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
      rules: rulesFor("arrival"),
    },
    {
      files: [...DOCUMENT_PATTERNS],
      language: "markdown/commonmark",
      plugins: { markdown, law: plugin },
      linterOptions: { reportUnusedDisableDirectives: "error" },
      rules: rulesFor("documents"),
    },
  ];
}

export default await buildConfig(process.env.GOVERNANCE_DOOR ?? "window");
