/**
 * Floors-up-only ratchet (#496 E4, extended #532).
 *
 * governance: allow-repo-hygiene file-size-limit (#532) pure comparison helpers
 * for coverage, mutation, minimumTests, and perf budgets share one module so
 * unit tests and the CLI entry share a single source of truth.
 *
 * Diffs against a git merge-base (default: origin/main):
 *   - `tests/floors.json#coverage` (up-only)
 *   - every claims flow `minimumTests` (up-only)
 *   - `tests/floors.json#mutation` (up-only mutation scores, #532)
 *   - perf budget numeric ceilings/floors (tighten-only / widen fails, #532)
 *
 * #915 Wave 4 merged twenty ledgers into four. The ceiling table below names
 * SECTIONS of `tests/budgets.json` rather than seven separate files, and each
 * section keeps its OWN `approvedDeviation` — merging the files must not merge
 * the waivers, or a reviewed widen of one ceiling would silently waive a drop
 * in another. `scripts/check-ledgers.mjs` (`bun run lint:ledgers`) holds the
 * rest of the merged shape (issue-and-expiry, the derived mirrors, the
 * inventory budgets); this module stays the numeric ratchet the report reads.
 *
 * Any decrease (or budget widen) fails unless the touched file's
 * `approvedDeviation` (flow-level: `approvedMinimumTestsDeviation`) was
 * CHANGED in the same change set — mere presence never waives, because the
 * field is a permanent provenance ledger and is non-empty forever (#781).
 *
 * Deletion of a floor scope, metric key, or flow `minimumTests` counts as a
 * decrease (cannot bypass the ratchet by deleting the key).
 *
 * Usage:
 *   node scripts/test-report/ratchet-floors.mjs
 *   node scripts/test-report/ratchet-floors.mjs --base origin/main
 *   node scripts/test-report/ratchet-floors.mjs --base <sha>
 *
 * Pure comparison is exported for unit tests.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

/** Perf budget source files ratcheted under #532 (path → kind). */
export const PERF_BUDGET_SOURCES = [
  { path: "apps/web/tests/e2e/perf-budgets.ts", exportName: "perfBudgets" },
  { path: "packages/server/benchmarks/low-end-budgets.json" },
  // #656 Layer 1F — the nightly rig registry. `regressionMultiplier` and each
  // rig's `budgetMs` are ceilings (tighten-only); `minimumSamples` is a min*
  // floor and may only rise. Before this the absolute ceilings lived as
  // `const BUDGET_MS` inside five rig files, where widening one to make a slow
  // rig green was an unreviewed one-line edit.
  {
    path: "tests/budgets.json",
    section: "qualityRigs",
    legacy: "tests/quality-rig-budgets.json",
  },
  // #656 Layer 5 — the PR lane's total wall clock. Tighten-only for the same
  // reason as any perf ceiling: it is the only gate that pushes back on adding
  // tests, so widening it must be a reviewed edit rather than a quiet one.
  {
    path: "tests/budgets.json",
    section: "suiteWallClock",
    legacy: "tests/suite-wall-clock.json",
  },
  // #915 — the ladder's own p95 budget per rung, lifted out of a literal in
  // scripts/ci/lane-rules.mjs so that widening a rung is a reviewed edit.
  { path: "tests/budgets.json", section: "rungs" },
  // #915 Wave 2/4 — the mobile suite budgets, mirrored from the roster. The
  // roster is still ratcheted at its own source by check-mobile-suite-budgets;
  // this holds the mirror to the same direction so neither copy can drift up.
  { path: "tests/budgets.json", section: "mobileSuites" },
  // #659 R2 — the EXPERIENCE budgets: the same regressions the files above
  // fence, restated as what the vault owner feels (cold open → first usable
  // screen, tap → visual response, send → first token, scroll frame drops,
  // sync staleness after reconnect). One file per shipping surface; see
  // tests/experience-budgets/README.md for the status vocabulary and the
  // year-3 volume table every ceiling is stated at. Entries with
  // `status: "unmeasured"` deliberately carry NO number, so they contribute
  // nothing to the ratchet until a real run fills them in.
  { path: "tests/experience-budgets/web.json" },
  { path: "tests/experience-budgets/desktop.json" },
  { path: "tests/experience-budgets/mobile.json" },
  { path: "tests/experience-budgets/gateway.json" },
  // #842 W3.5 — the renderer-leak ceilings. Same tighten-only posture as every
  // budget above: a ceiling may drop freely, and widening one must be a
  // reviewed edit. These are load-bearing in a way a perf number is not — the
  // lane's whole argument is that each ceiling sits strictly BELOW the cycle
  // count, so a per-cycle residue cannot hide under it. Widening one past the
  // cycle count silently converts a leak detector into a leak tolerator.
  { path: "apps/web/tests/e2e/leak-budgets.ts", exportName: "leakBudgets" },
];

/**
 * Compare coverage floor objects for any downward movement or deletion.
 * @param {unknown} base Floors on the merge base.
 * @param {unknown} head Floors on the working tree.
 * @returns {string[]} Human-readable decrease errors.
 */
export function diffCoverageFloors(base, head) {
  const errors = [];
  if (!base || typeof base !== "object" || !head || typeof head !== "object") {
    return errors;
  }
  const baseObj = /** @type {Record<string, unknown>} */ (base);
  const headObj = /** @type {Record<string, unknown>} */ (head);
  const keys = new Set([...Object.keys(baseObj), ...Object.keys(headObj)]);
  for (const key of keys) {
    if (key === "approvedDeviation" || key.startsWith("_")) continue;
    const b = baseObj[key];
    const h = headObj[key];
    if (typeof b === "number") {
      if (typeof h !== "number") {
        errors.push(`coverage floor "${key}" removed (was ${b})`);
      } else if (h < b) {
        errors.push(`coverage floor "${key}" decreased ${b} → ${h}`);
      }
      continue;
    }
    if (b && typeof b === "object") {
      if (!h || typeof h !== "object") {
        errors.push(`coverage floor scope "${key}" removed`);
        continue;
      }
      const bb = /** @type {Record<string, number>} */ (b);
      const hh = /** @type {Record<string, number>} */ (h);
      for (const metric of new Set([...Object.keys(bb), ...Object.keys(hh)])) {
        if (typeof bb[metric] !== "number") continue;
        if (typeof hh[metric] !== "number") {
          errors.push(
            `coverage floor "${key}.${metric}" removed (was ${bb[metric]})`
          );
        } else if (hh[metric] < bb[metric]) {
          errors.push(
            `coverage floor "${key}.${metric}" decreased ${bb[metric]} → ${hh[metric]}`
          );
        }
      }
    }
  }
  return errors;
}

/**
 * Compare mutation-score floors for any downward movement or deletion (#532).
 * Same shape as coverage floors: top-level package keys → number scores.
 * @param {unknown} base Mutation floors on the merge base.
 * @param {unknown} head Mutation floors on the working tree.
 * @returns {string[]} Human-readable decrease errors.
 */
export function diffMutationFloors(base, head) {
  return diffCoverageFloors(base, head).map((e) =>
    e.replace(/^coverage floor/u, "mutation floor")
  );
}

/**
 * Compare matrix flow minimumTests floors for any downward movement or removal.
 * An ID rename must name its exact predecessor with
 * `replacesMinimumTestsFlow`; a prose deviation alone cannot let one new flow
 * absorb several removed floors.
 * @param {{ flows?: Array<{ id?: string; surface?: string; dimension?: string; tier?: string; minimumTests?: number; approvedMinimumTestsDeviation?: string; replacesMinimumTestsFlow?: string }> }} base Matrix on the merge base.
 * @param {{ flows?: Array<{ id?: string; surface?: string; dimension?: string; tier?: string; minimumTests?: number; approvedMinimumTestsDeviation?: string; replacesMinimumTestsFlow?: string }> }} head Matrix on the working tree.
 * @returns {string[]} Human-readable decrease errors.
 */
export function diffMinimumTests(base, head) {
  const errors = [];
  const baseFlows = base?.flows ?? [];
  const headFlows = head?.flows ?? [];
  const baseMap = new Map(baseFlows.filter((f) => f?.id).map((f) => [f.id, f]));
  const headMap = new Map(headFlows.filter((f) => f?.id).map((f) => [f.id, f]));
  const replacements = new Map();
  for (const candidate of headFlows) {
    if (
      typeof candidate?.replacesMinimumTestsFlow !== "string" ||
      !candidate.replacesMinimumTestsFlow.trim()
    ) {
      continue;
    }
    const previousId = candidate.replacesMinimumTestsFlow.trim();
    const claimed = replacements.get(previousId) ?? [];
    claimed.push(candidate);
    replacements.set(previousId, claimed);
  }
  for (const [previousId, candidates] of replacements) {
    if (!baseMap.has(previousId)) {
      errors.push(`flow replacement names unknown predecessor "${previousId}"`);
    } else if (headMap.has(previousId)) {
      errors.push(
        `flow replacement names retained predecessor "${previousId}"`
      );
    }
    if (candidates.length > 1) {
      errors.push(
        `flow "${previousId}" has multiple replacements (${candidates
          .map((candidate) => `"${candidate.id ?? "<missing id>"}"`)
          .join(", ")}); ID renames must be one-to-one`
      );
    }
  }
  for (const prev of baseFlows) {
    if (!prev?.id || prev.minimumTests === undefined) continue;
    const flow = headMap.get(prev.id);
    if (!flow || flow.minimumTests === undefined) {
      const candidates = replacements.get(prev.id) ?? [];
      const candidate = candidates.length === 1 ? candidates[0] : undefined;
      const approvedReplacement =
        candidate?.id !== undefined &&
        candidate.id !== prev.id &&
        !baseMap.has(candidate.id) &&
        candidate.surface === prev.surface &&
        candidate.dimension === prev.dimension &&
        candidate.tier === prev.tier &&
        typeof candidate.minimumTests === "number" &&
        candidate.minimumTests >= prev.minimumTests &&
        typeof candidate.approvedMinimumTestsDeviation === "string" &&
        candidate.approvedMinimumTestsDeviation.trim();
      if (approvedReplacement) continue;
      if (
        flow &&
        typeof flow.approvedMinimumTestsDeviation === "string" &&
        flow.approvedMinimumTestsDeviation.trim()
      ) {
        continue;
      }
      if (flow) {
        errors.push(
          `flow "${prev.id}" minimumTests removed (was ${prev.minimumTests}; add approvedMinimumTestsDeviation to allow)`
        );
      } else {
        errors.push(
          `flow "${prev.id}" removed (had minimumTests ${prev.minimumTests}); add one approved replacement with replacesMinimumTestsFlow: "${prev.id}" or restore the flow`
        );
      }
      continue;
    }
    if (flow.minimumTests < prev.minimumTests) {
      if (
        typeof flow.approvedMinimumTestsDeviation === "string" &&
        flow.approvedMinimumTestsDeviation.trim()
      ) {
        continue;
      }
      errors.push(
        `flow "${flow.id}" minimumTests decreased ${prev.minimumTests} → ${flow.minimumTests} (add approvedMinimumTestsDeviation to allow)`
      );
    }
  }
  return errors;
}

/**
 * Whether a budget leaf key is a floor (higher is tighter) rather than a
 * ceiling (lower is tighter). Keys starting with `min` (camelCase min*) are
 * floors; everything else is treated as a ceiling.
 * @param {string} key Leaf property name (last path segment).
 * @returns {boolean} Return value.
 */
export function isBudgetFloorKey(key) {
  return /^min[A-Z_]|^minimum/iu.test(key);
}

/**
 * Flatten nested budget objects into dotted paths → numbers.
 * @param {unknown} value Budget object tree.
 * @param {string} [prefix] Path prefix.
 * @returns {Record<string, number>} Return value.
 */
export function flattenBudgetNumbers(value, prefix = "") {
  /** @type {Record<string, number>} */
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, child] of Object.entries(
    /** @type {Record<string, unknown>} */ (value)
  )) {
    if (key.startsWith("_") || key === "approvedDeviation") continue;
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "number" && Number.isFinite(child)) {
      out[pathKey] = child;
    } else if (child && typeof child === "object" && !Array.isArray(child)) {
      Object.assign(out, flattenBudgetNumbers(child, pathKey));
    }
  }
  return out;
}

/**
 * Extract nested numeric budget literals from a TypeScript/JS module source
 * that assigns `export const <exportName> = { ... }`. Pure — no eval.
 * @param {string} source File contents.
 * @param {string} exportName Exported const name (e.g. `perfBudgets`).
 * @returns {Record<string, number>} Flattened path → number.
 */
export function extractBudgetNumbersFromSource(source, exportName) {
  const marker = new RegExp(
    `export\\s+const\\s+${exportName}\\s*(?::\\s*[^=]+)?=\\s*\\{`,
    "u"
  );
  const match = marker.exec(source);
  if (!match || match.index === undefined) return {};
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return {};
  return parseBudgetObjectLiteral(source.slice(start, end + 1));
}

/**
 * Parse a `{ a: 1, b: { c: 2 } }` object literal into flattened numbers.
 * @param {string} text Object literal including outer braces.
 * @returns {Record<string, number>} Return value.
 */
function parseBudgetObjectLiteral(text) {
  /** @type {Record<string, number>} */
  const out = {};
  /** @type {string[]} */
  const stack = [];
  let i = 0;
  const s = text;

  function skipWs() {
    while (i < s.length && /\s|,/u.test(s[i])) i += 1;
  }

  function readIdent() {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  }

  function readNumber() {
    const m = /^-?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/u.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0].replace(/_/gu, ""));
  }

  function parseObject() {
    if (s[i] !== "{") return;
    i += 1;
    while (i < s.length) {
      skipWs();
      if (s[i] === "}") {
        i += 1;
        return;
      }
      if (s[i] === "/" && s[i + 1] === "/") {
        while (i < s.length && s[i] !== "\n") i += 1;
        continue;
      }
      if (s[i] === "/" && s[i + 1] === "*") {
        i += 2;
        while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i += 1;
        i += 2;
        continue;
      }
      const key = readIdent();
      if (!key) {
        i += 1;
        continue;
      }
      skipWs();
      if (s[i] === ":") i += 1;
      skipWs();
      if (s[i] === "{") {
        stack.push(key);
        parseObject();
        stack.pop();
      } else {
        const num = readNumber();
        if (num !== null && Number.isFinite(num)) {
          out[[...stack, key].join(".")] = num;
        } else {
          while (i < s.length && s[i] !== "," && s[i] !== "}") i += 1;
        }
      }
      skipWs();
    }
  }

  skipWs();
  parseObject();
  return out;
}

/**
 * Diff two flattened budget maps. Ceilings may only decrease (tighten);
 * floors (min*) may only increase. Removal of a key is a widen.
 * @param {Record<string, number>} base Flat base budgets.
 * @param {Record<string, number>} head Flat head budgets.
 * @param {string} [label] Source label for error messages.
 * @returns {string[]} Return value.
 */
export function diffPerfBudgetNumbers(base, head, label = "perf budget") {
  const errors = [];
  for (const key of Object.keys(base)) {
    const leaf = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1) : key;
    const floor = isBudgetFloorKey(leaf);
    const b = base[key];
    const h = head[key];
    if (typeof h !== "number") {
      errors.push(`${label} "${key}" removed (was ${b})`);
      continue;
    }
    if (floor) {
      if (h < b) {
        errors.push(
          `${label} "${key}" loosened ${b} → ${h} (min floors may only rise)`
        );
      }
    } else if (h > b) {
      errors.push(
        `${label} "${key}" widened ${b} → ${h} (ceilings may only tighten)`
      );
    }
  }
  return errors;
}

/**
 * True when head object carries a non-empty approvedDeviation string.
 * @param {unknown} head head parameter.
 * @returns {boolean} Return value.
 */
export function hasApprovedDeviation(head) {
  return (
    !!head &&
    typeof head === "object" &&
    typeof (
      /** @type {{ approvedDeviation?: string }} */ (head).approvedDeviation
    ) === "string" &&
    /** @type {{ approvedDeviation: string }} */ (head).approvedDeviation.trim()
      .length > 0
  );
}

/**
 * Read an object's approvedDeviation string ("" when absent/invalid).
 * @param {unknown} obj Floors/mutation JSON object.
 * @returns {string} Return value.
 */
function deviationOf(obj) {
  if (!obj || typeof obj !== "object") return "";
  const value =
    /** @type {{ approvedDeviation?: unknown }} */ (obj).approvedDeviation;
  return typeof value === "string" ? value : "";
}

/**
 * True when head's approvedDeviation both exists and CHANGED vs base.
 *
 * Mere presence is not consent: approvedDeviation is a permanent provenance
 * ledger that is non-empty on every ratcheted file forever, so a
 * presence-only waiver would waive every decrease and deletion for all time —
 * the ratchet could never fire (found by the #781 wave-3 audit). A decrease
 * is deliberate exactly when the same change set extended the ledger.
 * @param {unknown} base Base-ref object (null on first land).
 * @param {unknown} head Working-tree object.
 * @returns {boolean} Return value.
 */
export function deviationChanged(base, head) {
  if (!hasApprovedDeviation(head)) return false;
  return deviationOf(base) !== deviationOf(head);
}

/**
 * Run the full floors-up-only ratchet.
 * @param {object} opts Comparison inputs.
 * @param {unknown} opts.baseFloors Floors JSON on the merge base.
 * @param {unknown} opts.headFloors Floors on the working tree.
 * @param {object} opts.baseMatrix Matrix JSON on the merge base.
 * @param {object} opts.headMatrix Matrix JSON on the working tree.
 * @param {unknown} [opts.baseMutation] Mutation floors on merge base (null = first land).
 * @param {unknown} [opts.headMutation] Mutation floors on head.
 * @param {Array<{ label: string; base: Record<string, number>; head: Record<string, number>; approvedDeviation?: string; baseApprovedDeviation?: string }>} [opts.perfBudgets] Perf budget comparison entries.
 * @returns {{ errors: string[]; waived: boolean }} Return value.
 */
export function ratchetFloors({
  baseFloors,
  headFloors,
  baseMatrix,
  headMatrix,
  baseMutation = null,
  headMutation = null,
  perfBudgets = [],
}) {
  const floors = diffCoverageFloors(baseFloors, headFloors);
  const mins = diffMinimumTests(baseMatrix, headMatrix);
  const mutation =
    baseMutation && headMutation
      ? diffMutationFloors(baseMutation, headMutation)
      : [];
  /** @type {string[]} */
  const perf = [];
  for (const entry of perfBudgets) {
    const errs = diffPerfBudgetNumbers(entry.base, entry.head, entry.label);
    if (
      errs.length &&
      entry.approvedDeviation &&
      entry.approvedDeviation.trim() &&
      entry.approvedDeviation !== (entry.baseApprovedDeviation ?? "")
    ) {
      continue;
    }
    perf.push(...errs);
  }

  let remainingFloors = floors;
  let remainingMutation = mutation;
  if (floors.length > 0 && deviationChanged(baseFloors, headFloors))
    remainingFloors = [];
  if (mutation.length > 0 && deviationChanged(baseMutation, headMutation))
    remainingMutation = [];

  const remaining = [
    ...remainingFloors,
    ...remainingMutation,
    ...mins,
    ...perf,
  ];
  const anyWaived =
    (floors.length > 0 && remainingFloors.length === 0) ||
    (mutation.length > 0 && remainingMutation.length === 0);
  return { errors: remaining, waived: anyWaived };
}

function readJsonAt(ref, relPath) {
  try {
    const raw = execFileSync("git", ["show", `${ref}:${relPath}`], {
      cwd: root,
      encoding: "utf8",
      // A path absent on the base is the FIRST-LAND case, handled by the
      // callers; git's "exists on disk, but not in <ref>" on stderr would read
      // as a gate failure in the log when it is nothing of the sort.
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readTextAt(ref, relPath) {
  try {
    return execFileSync("git", ["show", `${ref}:${relPath}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function resolveBase(explicit) {
  if (explicit) return explicit;
  for (const candidate of ["origin/main", "main", "origin/master", "master"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", candidate], {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function parseArgs(argv) {
  const out = { base: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base" && argv[i + 1]) {
      out.base = argv[++i];
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      out.help = true;
    }
  }
  return out;
}

/**
 * Load flattened budget numbers from a working-tree or base-ref source.
 * @param {string} absPath Absolute path on disk for head.
 * @param {{ path: string; exportName?: string; section?: string; legacy?: string }} source Source descriptor. `section` names one section of a merged ledger; `legacy` is the standalone file it lived in before #915 Wave 4, read only on the base side.
 * @param {string | null} ref Git ref, or null for working tree.
 * @returns {{ numbers: Record<string, number>; approvedDeviation: string }} Return value.
 */
function loadBudgetSource(absPath, source, ref) {
  let text = null;
  let section = source.section;
  if (ref) {
    text = readTextAt(ref, source.path);
    if (text === null && source.legacy) {
      // The merged ledger does not exist on the base: read the file this
      // section used to be, whole, so the rename cannot widen a ceiling.
      text = readTextAt(ref, source.legacy);
      section = undefined;
    }
  } else if (existsSync(absPath)) {
    text = readFileSync(absPath, "utf8");
  }
  if (!text) return { numbers: {}, approvedDeviation: "" };

  let approvedDeviation = "";
  const waiver =
    /approvedDeviation\s*[:=]\s*['"`](?<deviation>[^'"`]+)['"`]/u.exec(text);
  if (waiver?.groups?.deviation) approvedDeviation = waiver.groups.deviation;

  if (source.path.endsWith(".json")) {
    try {
      const whole = JSON.parse(text);
      // A section's waiver is its own. Reading the file-level note would let a
      // reviewed widen of one budget waive a drop in the section next door.
      const parsed = section ? (whole[section] ?? {}) : whole;
      approvedDeviation =
        typeof parsed.approvedDeviation === "string"
          ? parsed.approvedDeviation
          : "";
      return { numbers: flattenBudgetNumbers(parsed), approvedDeviation };
    } catch {
      return { numbers: {}, approvedDeviation };
    }
  }
  if (source.exportName) {
    return {
      numbers: extractBudgetNumbersFromSource(text, source.exportName),
      approvedDeviation,
    };
  }
  return { numbers: {}, approvedDeviation };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/test-report/ratchet-floors.mjs [--base <ref>]"
    );
    process.exit(0);
  }
  const baseRef = resolveBase(args.base);
  if (!baseRef) {
    console.error(
      "ratchet-floors: no merge base found (tried origin/main, main, origin/master, master). Fetch the default branch or pass --base <ref>."
    );
    process.exitCode = 1;
    return;
  }

  const floorsPath = "tests/floors.json";
  const matrixPath = "tests/claims.json";
  if (
    !existsSync(path.join(root, floorsPath)) ||
    !existsSync(path.join(root, matrixPath))
  ) {
    console.error(
      `ratchet-floors: missing ${floorsPath} or ${matrixPath} in working tree`
    );
    process.exitCode = 1;
    return;
  }
  const floorsDoc = JSON.parse(
    readFileSync(path.join(root, floorsPath), "utf8")
  );
  const headFloors = floorsDoc.coverage;
  const headMatrix = JSON.parse(
    readFileSync(path.join(root, matrixPath), "utf8")
  );
  // #915 Wave 4 merged tests/coverage-floors.json and tests/mutation-floors.json
  // into tests/floors.json. The base side falls back to the OLD paths so the
  // very commit that renamed them cannot lower a floor unwatched — without this
  // the ratchet would go silent for exactly one merge.
  const baseFloorsDoc = readJsonAt(baseRef, floorsPath);
  const baseFloors =
    baseFloorsDoc?.coverage ??
    readJsonAt(baseRef, "tests/coverage-floors.json");
  // #915 renamed tests/matrix.json to tests/claims.json. The `flows[]`
  // minimumTests floors moved file, not value, so the base side falls back to
  // the old path: without this the ratchet would go silent for exactly one
  // merge, which is when a floor could be lowered unwatched.
  const baseMatrix =
    readJsonAt(baseRef, matrixPath) ?? readJsonAt(baseRef, "tests/matrix.json");

  const headMutation = floorsDoc.mutation ?? null;
  const baseMutation =
    baseFloorsDoc?.mutation ??
    readJsonAt(baseRef, "tests/mutation-floors.json");

  if (!baseFloors || !baseMatrix) {
    if (!baseFloors && !baseMatrix) {
      console.log(
        `ratchet-floors: ${floorsPath} and ${matrixPath} absent on ${baseRef}; nothing to ratchet (first land)`
      );
      return;
    }
    console.error(
      `ratchet-floors: ${baseFloors ? matrixPath : floorsPath} missing on ${baseRef} while present on head — refusing silent skip`
    );
    process.exitCode = 1;
    return;
  }

  // Mutation floors: first land (absent on base) is fine; once both sides have
  // the file, decreases require approvedDeviation.
  if (headMutation && !baseMutation) {
    console.log(
      `ratchet-floors: ${floorsPath}#mutation absent on ${baseRef}; mutation floors first land (ok)`
    );
  }

  /** @type {Array<{ label: string; base: Record<string, number>; head: Record<string, number>; approvedDeviation?: string; baseApprovedDeviation?: string }>} */
  const perfBudgets = [];
  for (const source of PERF_BUDGET_SOURCES) {
    const abs = path.join(root, source.path);
    const head = loadBudgetSource(abs, source, null);
    const base = loadBudgetSource(abs, source, baseRef);
    if (Object.keys(base.numbers).length === 0) {
      // First land of this budget file — nothing to ratchet.
      continue;
    }
    perfBudgets.push({
      label: source.section ? `${source.path}#${source.section}` : source.path,
      base: base.numbers,
      head: head.numbers,
      approvedDeviation: head.approvedDeviation,
      baseApprovedDeviation: base.approvedDeviation,
    });
  }

  const { errors, waived } = ratchetFloors({
    baseFloors,
    headFloors,
    baseMatrix,
    headMatrix,
    baseMutation: baseMutation && headMutation ? baseMutation : null,
    headMutation: baseMutation && headMutation ? headMutation : null,
    perfBudgets,
  });
  if (errors.length) {
    console.error(
      `ratchet-floors: floors/budgets may only tighten (base ${baseRef})`
    );
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      "To lower a floor or widen a budget deliberately, EXTEND the touched file's approvedDeviation with the new rationale (mere presence of old ledger text never waives — #781) or set approvedMinimumTestsDeviation on the same flow. An ID rename also requires an exact one-to-one replacesMinimumTestsFlow mapping."
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    waived
      ? `ratchet-floors: ok (decrease(s) waived by a CHANGED approvedDeviation vs ${baseRef})`
      : `ratchet-floors: ok (no decreases vs ${baseRef})`
  );
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  main();
}
