/**
 * The one evidence writer (#915 Wave 3, contract C2).
 *
 * Every rung 2–5 lane ends with a `Write lane evidence` step that calls this
 * script with `if: always()`, so the report can tell "the lane failed" from
 * "the lane never spoke". The interface is deliberately stable — the CI slice
 * builds workflow steps against it and the report slice builds the reader
 * against the same schema module.
 *
 *   node scripts/test-report/write-evidence.mjs \
 *     --lane <id> --rung <n> --platform <p> --verdict <v|auto> \
 *     [--job-status <success|failure|cancelled>] \
 *     --started-at <ISO> [--finished-at <ISO>] --budget-ms <n> \
 *     [--cases <path-to-json-array>] [--qualities a,b] [--surfaces x,y] \
 *     [--candidate <sha>] [--out artifacts/evidence]
 *
 * `--verdict auto` maps `job.status` (success → passed, anything else →
 * failed), which is why the step can be one line in YAML. A lane with an
 * unexpired park in the parks ledger is downgraded from `failed` to `parked`
 * here rather than in the report: the park is a fact about the lane at the
 * moment it ran, and writing it into the evidence keeps the report a pure
 * function of the directory.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  EVIDENCE_SCHEMA_VERSION,
  evidenceFileName,
  validateEvidence,
} from "./evidence-schema.mjs";

const root = path.resolve(import.meta.dirname, "../..");

/** Lane parks, merged into the quarantine ledger by #915 Wave 4. */
export const PARK_SOURCES = Object.freeze(["tests/quarantine.json"]);

/**
 * Parse `--flag value` pairs. Unknown flags are an error, so a typo in a
 * workflow fails the step instead of silently writing default evidence.
 * @param {string[]} argv the argument list, without the node and script entries
 * @param {Set<string>} known the flags this CLI accepts; anything else is a typo, not a default
 */
export function parseArgs(argv, known) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--"))
      throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!known.has(name)) throw new Error(`unknown flag: --${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} needs a value`);
    }
    flags[name] = value;
    index += 1;
  }
  return flags;
}

const KNOWN_FLAGS = new Set([
  "lane",
  "rung",
  "platform",
  "verdict",
  "job-status",
  "started-at",
  "finished-at",
  "budget-ms",
  "duration-ms",
  "cases",
  "qualities",
  "surfaces",
  "candidate",
  "out",
]);

/**
 * Resolve `--verdict auto` against a GitHub `job.status`.
 * @param {string} verdict the `--verdict` value, possibly `auto`
 * @param {string|undefined} jobStatus GitHub's `job.status` for the lane
 */
export function resolveVerdict(verdict, jobStatus) {
  if (verdict !== "auto") return verdict;
  if (!jobStatus) throw new Error("--verdict auto needs --job-status");
  return jobStatus === "success" ? "passed" : "failed";
}

/**
 * The unexpired park for `lane`, from whichever parks ledger exists. Lane
 * parks are read first so a lane and a test of the same name cannot collide.
 * @param {string} lane a lane registry entry
 * @param {(relative: string) => string|null} readText reads a repo-relative file, or returns null
 * @param {string} today YYYY-MM-DD
 * @returns {{until: string, issue: number}|null} the unexpired park, or null
 */
export function lookupPark(lane, readText, today) {
  for (const source of PARK_SOURCES) {
    const text = readText(source);
    if (!text) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${source} is not valid JSON`);
    }
    const entry = parsed?.lanes?.[lane];
    if (!entry) continue;
    const until = String(entry.expires ?? entry.until ?? "");
    if (!until || until < today) continue;
    const issue = Number(String(entry.issue ?? "").replace(/^#/u, ""));
    if (!Number.isInteger(issue) || issue <= 0) {
      throw new Error(`${source} lane park for ${lane} has no issue number`);
    }
    return { until, issue };
  }
  return null;
}

/** Split a comma list into trimmed, non-empty tags. */
function tagList(value) {
  return value === undefined
    ? []
    : value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

/**
 * Build the evidence object. Pure, so the unit tests do not touch disk.
 * @param {Record<string, string>} flags the parsed CLI flags
 * @param {{now: Date, park: {until: string, issue: number}|null, cases: unknown[]}} context the clock, the lane's park (or null) and the parsed cases
 */
export function buildEvidence(flags, context) {
  const startedAt = flags["started-at"];
  if (!startedAt) throw new Error("--started-at is required");
  const finishedAt = flags["finished-at"] ?? context.now.toISOString();
  const declared = resolveVerdict(flags.verdict ?? "", flags["job-status"]);
  // A park is a date on the debt, not a mute: the lane still ran and still
  // wrote its duration and cases; only the word changes, so the verdict does
  // not count it as red (#915 Wave 0).
  const verdict = context.park && declared === "failed" ? "parked" : declared;
  const durationMs =
    flags["duration-ms"] === undefined
      ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))
      : Number(flags["duration-ms"]);

  return {
    schema: EVIDENCE_SCHEMA_VERSION,
    lane: flags.lane,
    rung: Number(flags.rung),
    platform: flags.platform,
    candidate: flags.candidate ? flags.candidate : null,
    startedAt,
    finishedAt,
    verdict,
    budgetMs: Number(flags["budget-ms"] ?? 0),
    durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    cases: context.cases,
    parked: context.park,
    tags: {
      qualities: tagList(flags.qualities),
      surfaces: tagList(flags.surfaces),
    },
  };
}

/** Read a JSON array of cases, or an empty list when no file was given. */
function readCases(casesPath) {
  if (!casesPath) return [];
  const parsed = JSON.parse(
    readFileSync(path.resolve(root, casesPath), "utf8")
  );
  if (!Array.isArray(parsed)) throw new Error("--cases must name a JSON array");
  return parsed;
}

/** The CLI body, exported so a test can drive it against a temp root. */
export function main(argv, options = {}) {
  const flags = parseArgs(argv, KNOWN_FLAGS);
  const now = options.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const readText =
    options.readText ??
    ((relative) => {
      try {
        return readFileSync(path.join(root, relative), "utf8");
      } catch {
        return null;
      }
    });

  const park = lookupPark(String(flags.lane ?? ""), readText, today);
  const evidence = buildEvidence(flags, {
    now,
    park,
    cases: readCases(flags.cases),
  });
  const { ok, errors } = validateEvidence(evidence);
  if (!ok) {
    throw new Error(
      `refusing to write invalid evidence:\n  ${errors.join("\n  ")}`
    );
  }

  const outDir = path.resolve(root, flags.out ?? "artifacts/evidence");
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, evidenceFileName(evidence.lane));
  writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return { file, evidence };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  try {
    const { file } = main(process.argv.slice(2));
    process.stdout.write(`wrote ${path.relative(root, file)}\n`);
  } catch (error) {
    process.stderr.write(`write-evidence: ${error.message}\n`);
    process.exitCode = 1;
  }
}
