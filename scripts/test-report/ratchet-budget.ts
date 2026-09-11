/**
 * Budget flattening and tighten-only diffs for the floors ratchet (#532).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { dict, isRecord } from "./record.ts";

const root = path.resolve(import.meta.dirname, "../..");

/** Perf budget source files ratcheted under #532 (path → kind). */
export const PERF_BUDGET_SOURCES = [
  { path: "apps/web/tests/e2e/perf-budgets.ts", exportName: "perfBudgets" },
  { path: "packages/server/benchmarks/low-end-budgets.json" },
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
  // #927 — THE JOURNEY LEDGER, keyed `surface / journey / volume / hardware`.
  // It replaced four per-surface experience files, the rig register and the
  // query-count file, whose keys said which SURFACE a ceiling belonged to but
  // not the volume or the hardware it held at. `legacy` keeps the merge that
  // created it from reading as a wholesale widen. A metric with
  // `status: "unmeasured"` carries NO number and contributes nothing here
  // until a real run fills it in; a leading underscore is invisible, which is
  // how an intended-but-unobserved ceiling is parked without gating.
  { path: "tests/journeys.json" },
  // #842 W3.5 — the renderer-leak ceilings. Same tighten-only posture as every
  // budget above: a ceiling may drop freely, and widening one must be a
  // reviewed edit. These are load-bearing in a way a perf number is not — the
  // lane's whole argument is that each ceiling sits strictly BELOW the cycle
  // count, so a per-cycle residue cannot hide under it. Widening one past the
  // cycle count silently converts a leak detector into a leak tolerator.
  { path: "apps/web/tests/e2e/leak-budgets.ts", exportName: "leakBudgets" },
];

export function isBudgetFloorKey(key: string): boolean {
  return /^min[A-Z_]|^minimum/iu.test(key);
}

/**
 * Flatten nested budget objects into dotted paths → numbers.
 * @param {unknown} value Budget object tree.
 * @param {string} [prefix] Path prefix.
 * @returns {Record<string, number>} Return value.
 */
export function flattenBudgetNumbers(
  value: unknown,
  prefix: string | undefined = ""
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(value)) return out;
  for (const [key, child] of Object.entries(value)) {
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
export function extractBudgetNumbersFromSource(
  source: string,
  exportName: string
): Record<string, number> {
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
function parseBudgetObjectLiteral(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  const stack: string[] = [];
  let i = 0;
  const s = text;
  const at = (index: number) => s[index] ?? "";

  function skipWs() {
    while (i < s.length && /\s|,/u.test(at(i))) i += 1;
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
    if (at(i) !== "{") return;
    i += 1;
    while (i < s.length) {
      skipWs();
      if (at(i) === "}") {
        i += 1;
        return;
      }
      if (at(i) === "/" && at(i + 1) === "/") {
        while (i < s.length && at(i) !== "\n") i += 1;
        continue;
      }
      if (at(i) === "/" && at(i + 1) === "*") {
        i += 2;
        while (i < s.length && !(at(i) === "*" && at(i + 1) === "/")) i += 1;
        i += 2;
        continue;
      }
      const key = readIdent();
      if (!key) {
        i += 1;
        continue;
      }
      skipWs();
      if (at(i) === ":") i += 1;
      skipWs();
      if (at(i) === "{") {
        stack.push(key);
        parseObject();
        stack.pop();
      } else {
        const num = readNumber();
        if (num !== null && Number.isFinite(num)) {
          out[[...stack, key].join(".")] = num;
        } else {
          while (i < s.length && at(i) !== "," && at(i) !== "}") i += 1;
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
export function diffPerfBudgetNumbers(
  base: Record<string, number>,
  head: Record<string, number>,
  label: string | undefined = "perf budget"
): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(base)) {
    const leaf = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1) : key;
    const floor = isBudgetFloorKey(leaf);
    const b = base[key];
    const h = head[key];
    if (typeof h !== "number") {
      errors.push(`${label} "${key}" removed (was ${b})`);
      continue;
    }
    if (typeof b !== "number") continue;
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
export function hasApprovedDeviation(head: unknown): boolean {
  const value = dict(head).approvedDeviation;
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Read an object's approvedDeviation string ("" when absent/invalid).
 * @param {unknown} obj Floors/mutation JSON object.
 * @returns {string} Return value.
 */
function deviationOf(obj: unknown): string {
  const value = dict(obj).approvedDeviation;
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
export function deviationChanged(base: unknown, head: unknown): boolean {
  if (!hasApprovedDeviation(head)) return false;
  return deviationOf(base) !== deviationOf(head);
}

function readTextAt(ref: string, relPath: string) {
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

/**
 * Load flattened budget numbers from a working-tree or base-ref source.
 * @param {string} absPath Absolute path on disk for head.
 * @param {{ path: string; exportName?: string; section?: string; legacy?: string }} source Source descriptor. `section` names one section of a merged ledger; `legacy` is the standalone file it lived in before #915 Wave 4, read only on the base side.
 * @param {string | null} ref Git ref, or null for working tree.
 * @returns {{ numbers: Record<string, number>; approvedDeviation: string }} Return value.
 */
export function loadBudgetSource(
  absPath: string,
  source: {
    path: string;
    exportName?: string;
    section?: string;
    legacy?: string;
  },
  ref: string | null
): { numbers: Record<string, number>; approvedDeviation: string } {
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
  if (waiver?.groups?.deviation) approvedDeviation = waiver.groups?.deviation;

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
