#!/usr/bin/env node
// The runner: one command, one door, one line per rule (#1005).
//
// It does three things in order — generate the arrival record, build the
// config for the door, lint the governance documents the change touched — and
// then reports. **Every enabled rule prints, pass or fail.** A gate that is
// silent when it is happy is a gate nobody can tell is running, and the whole
// value of a rule catalog is that a reader can see the catalog.
//
// Usage:
//   node .governance/law/run.mjs [--door hook|window] [--range A..B]
//                                [--message-file F] [--arrival P]
//                                [--json] [--front-page P]
import { ESLint } from "eslint";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DOCUMENT_PATTERNS, buildConfig, loadRules } from "./eslint.config.mjs";
import { status as codeownersStatus } from "./codeowners.mjs";
import { lawDigestAt, lawPathsChanged, main as generateArrival } from "./arrival.mjs";
import { renderFrontPage } from "./front-page.mjs";
import { globToRegExp } from "./lib/digest.mjs";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..", "..");

/**
 * Parse argv.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {object} The options.
 */
export function parseArgs(argv) {
  const options = {
    door: "window",
    json: false,
    // A brief carries a stamp of the law it was written against. The env var
    // is how an orchestrator passes it without rewriting every call site.
    ...(process.env.GOVERNANCE_BRIEF_DIGEST
      ? { briefDigest: process.env.GOVERNANCE_BRIEF_DIGEST }
      : {}),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--door") options.door = argv[(i += 1)];
    else if (arg === "--range") options.range = argv[(i += 1)];
    else if (arg === "--message-file") options.messageFile = argv[(i += 1)];
    else if (arg === "--arrival") options.arrival = argv[(i += 1)];
    else if (arg === "--front-page") options.frontPage = argv[(i += 1)];
    else if (arg === "--brief-digest") options.briefDigest = argv[(i += 1)];
    else if (arg === "--json") options.json = true;
    else throw new Error(`law: unknown argument ${arg}`);
  }
  if (options.door !== "hook" && options.door !== "window") {
    throw new Error(`law: --door must be hook or window, got ${options.door}`);
  }
  return options;
}

/**
 * The governance documents this change touched, as repo-relative paths.
 *
 * Scoped to the change on purpose, for the same reason rung 0 is: a document
 * gate that fires on prose the author never opened is a gate people learn to
 * bypass (docs/dev-environment.md#the-local-gate-loop).
 *
 * @param {object} arrival The generated record.
 * @returns {string[]} Existing, matching paths, sorted and de-duplicated.
 */
export function documentsInRange(arrival) {
  const matchers = DOCUMENT_PATTERNS.map(globToRegExp);
  const touched = new Set(
    [...arrival.files, ...(arrival.pending?.files ?? [])]
      .filter((row) => row.status !== "D")
      .map((row) => row.path)
  );
  return [...touched]
    .filter((file) => matchers.some((matcher) => matcher.test(file)))
    .filter((file) => existsSync(path.join(ROOT, file)))
    .sort();
}

/**
 * What moved in the law since the brief an agent was given.
 *
 * The brief's digest names a state of the law, not a commit, so the commit is
 * FOUND: the range is walked from its base until one whose law digest matches.
 * A brief stamped with a state that is not in this range is honestly reported
 * as unknown rather than silently treated as "nothing changed" — the whole
 * point of the stamp is to say what the agent was not told.
 *
 * @param {string|undefined} stamped The digest the brief carries.
 * @param {object} range The resolved range.
 * @returns {{stamped: string, head: string, at: string|null, changed: string[]}|null}
 *   The comparison, or null when no brief was stamped.
 */
export function briefDrift(stamped, range) {
  if (!stamped) return null;
  const head = lawDigestAt(range.head);
  if (stamped === head) return { stamped, head, at: range.head, changed: [] };
  const candidates = [range.base, ...gitRevList(range)];
  const at = candidates.find((rev) => lawDigestAt(rev) === stamped) ?? null;
  return {
    stamped,
    head,
    at,
    changed: at === null ? [] : lawPathsChanged(at, range.head),
  };
}

/**
 * The commits of a range, oldest first.
 *
 * @param {object} range The resolved range.
 * @returns {string[]} The oids.
 */
function gitRevList(range) {
  return execFileSync("git", ["rev-list", "--reverse", `${range.base}..${range.head}`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
}

/**
 * Run the law over one door.
 *
 * @param {object} options Parsed options.
 * @returns {Promise<{report: object, arrival: object}>} The machine-readable run.
 */
export async function runLaw(options) {
  const arrivalPath = options.arrival
    ? path.resolve(ROOT, options.arrival)
    : await generateArrival([
        ...(options.range ? ["--range", options.range] : []),
        ...(options.messageFile ? ["--message-file", options.messageFile] : []),
        // The door is stamped into the record because it is a fact about the
        // change's situation, not about the rules: at the hook the only thing
        // the author can still act on is the commit being written, while in the
        // window every commit of the range is under review. A rule that judges
        // history at the hook is a rule that blocks a commit for something no
        // edit to it can fix.
        "--stamp",
        `door=${options.door}`,
      ]);
  // Read back rather than kept in memory: the rules lint the file on disk, so
  // the runner must report over the same bytes they saw.
  const arrival = JSON.parse(readFileSync(arrivalPath, "utf8"));

  // The catalog is resolved once and handed to the config builder, so the
  // lines this run prints and the rules ESLint ran are the same list by
  // construction rather than by two lookups agreeing.
  const rows = (options.rules ?? (await loadRules())).filter((row) =>
    options.door === "hook" ? row.door === "hook" : true
  );
  const arrivalRelative = path.relative(ROOT, arrivalPath);
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: true,
    baseConfig: await buildConfig(options.door, { declared: rows, arrivalPath: arrivalRelative }),
    errorOnUnmatchedPattern: false,
  });
  const targets = [arrivalRelative, ...documentsInRange(arrival)];
  const results = rows.length === 0 ? [] : await eslint.lintFiles(targets);

  const messages = results.flatMap((result) =>
    result.messages.map((message) => ({
      path: path.relative(ROOT, result.filePath),
      line: message.line ?? 0,
      column: message.column ?? 0,
      ruleId: message.ruleId,
      severity: message.severity === 2 ? "error" : "warn",
      message: message.message,
    }))
  );
  const report = {
    door: options.door,
    // What the host would have to enforce, and whether the file it reads to do
    // it still matches the law estate. The runner answers this, not a rule: it
    // is a fact about the working tree rather than about the change.
    codeowners: codeownersStatus(),
    lawDigest: { base: arrival.law.digestAtBase, head: arrival.law.digestAtHead },
    brief: briefDrift(options.briefDigest, arrival.range),
    lawChanged: arrival.law.changed,
    range: arrival.range,
    rules: rows.map((row) => {
      const count = messages.filter((message) => message.ruleId === `law/${row.id}`).length;
      return {
        id: row.id,
        door: row.door,
        severity: row.severity,
        verdict: count === 0 ? "pass" : "fail",
        count,
      };
    }),
    messages,
  };
  return { report, arrival };
}

/**
 * Print the human report.
 *
 * @param {object} report The run.
 * @returns {void}
 */
export function printReport(report) {
  const lines = [];
  for (const rule of report.rules) {
    lines.push(
      rule.verdict === "pass"
        ? `✓ ${rule.id}`
        : `✗ ${rule.id} — ${rule.count} finding${rule.count === 1 ? "" : "s"}`
    );
  }
  for (const message of report.messages) {
    lines.push(`    ${message.path}:${message.line} ${message.ruleId} — ${message.message}`);
  }
  const errors = report.messages.filter((message) => message.severity === "error").length;
  const warnings = report.messages.length - errors;
  lines.push(
    errors === 0 && warnings === 0
      ? `✓ law (${report.door} door): ${report.rules.length} rule(s), no findings`
      : `${errors === 0 ? "✓" : "✗"} law (${report.door} door): ${report.rules.length} rule(s), ${errors} error(s), ${warnings} warning(s)`
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * The CLI.
 *
 * @param {string[]} argv Arguments after the script name.
 * @param {object} [overrides] Options the CLI has no flag for (the resolved
 *   rule catalog), so a test can drive the real exit path.
 * @returns {Promise<number>} The exit code: 1 iff an error-severity finding.
 */
export async function main(argv, overrides = {}) {
  const options = { ...parseArgs(argv), ...overrides };
  const { report, arrival } = await runLaw(options);
  if (options.frontPage) {
    const out = path.resolve(ROOT, options.frontPage);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, renderFrontPage(report, arrival));
  }
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);
  return report.messages.some((message) => message.severity === "error") ? 1 : 0;
}

if (process.argv[1] === import.meta.filename) {
  process.exitCode = await main(process.argv.slice(2));
}
