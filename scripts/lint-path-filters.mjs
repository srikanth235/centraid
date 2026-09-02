#!/usr/bin/env node
/**
 * Path-filter inverse lint (#892 Phase 3).
 *
 * THE LOAD-BEARING FACT: in `ci.yml`, `skipped` counts as a PASS. That is
 * correct — it is what lets a path-gated lane roll up into the single required
 * `check` (#557) — and it makes the `changes` filter table the thing that
 * decides whether a lane ever runs at all. A directory no filter mentions wakes
 * no lane, reports `skipped`, and merges green. Nothing announces it.
 *
 * #890 W0 fixed one instance by hand: `tests/agent-e2e-mobile/**` was absent, so
 * editing a Maestro flow triggered NO mobile lane and the test layer of the
 * primary surface merged unexercised. This is the check that would have caught
 * it, and the one that catches the next one.
 *
 * THREE SUB-CHECKS.
 *
 *   claimed     every workspace directory (`packages/*`, `apps/*`) and every
 *               tracked top-level directory is named by at least one filter, or
 *               is listed in the ledger with the always-on job that covers it.
 *               An unclaimed path fails; a ledger entry for a path that no
 *               longer exists ALSO fails, because a stale exemption reads like a
 *               reviewed decision and is not one.
 *   tidy        no filter lists the same glob twice. The table is hand-kept and
 *               already shows the wear — `packages/server/**` appeared five
 *               times and `packages/core/**` twice inside the `gateway` filter —
 *               which is exactly the state in which a real omission is invisible.
 *   escape      every read of a filter output carries the `all` fallback. A
 *               `workflow_dispatch` run has no diff, so `changes` SKIPS the
 *               paths-filter step and every output is the empty string; `all` is
 *               what turns the lanes back on. `client-e2e` threaded it into its
 *               `if:` but not into its two `with:` inputs — the only reads in the
 *               file outside an `if:` — so the caller started, handed the lane
 *               `web: false, desktop: false`, and both inner jobs skipped. A
 *               manual full run on `main` exercised nothing and reported green.
 *               That is the `skipped`-counts-as-PASS hazard again, one level
 *               down, and reached through the very control meant to defeat it.
 *
 * Offline, no YAML dependency (the same line-scanning convention as
 * `lint-workflow-pins.mjs`), ~30 ms.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const CI_PATH = path.join(root, ".github/workflows/ci.yml");
const LEDGER_PATH = path.join(root, "tests/path-filter-ledger.json");

/**
 * Parse the `changes` job's `filters:` block into `{ name: globs[] }`.
 *
 * The block is a YAML string scalar (`filters: |`) inside the workflow, so it is
 * read by indentation rather than parsed: filter names sit at 12 spaces, their
 * globs at 14 as `- '…'`.
 */
export function parseFilters(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^\s{10}filters:\s*\|/u.test(line));
  if (start === -1) return null;
  const filters = {};
  let current = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    // Dedent out of the literal block ends it.
    if (!/^\s{12}/u.test(line)) break;
    const name = /^\s{12}(?<name>[\w-]+):\s*$/u.exec(line);
    if (name) {
      current = name.groups.name;
      filters[current] = [];
      continue;
    }
    const glob = /^\s{14}-\s*'(?<glob>[^']+)'\s*$/u.exec(line);
    if (glob && current) filters[current].push(glob.groups.glob);
  }
  return filters;
}

/** Duplicate globs inside a single filter. */
export function duplicateGlobs(filters) {
  const problems = [];
  for (const [name, globs] of Object.entries(filters)) {
    const seen = new Map();
    for (const glob of globs) seen.set(glob, (seen.get(glob) ?? 0) + 1);
    for (const [glob, count] of seen) {
      if (count > 1) {
        problems.push(
          `filter \`${name}\` lists \`${glob}\` ${count} times — the table is hand-kept, and duplication is the wear that hides a real omission`
        );
      }
    }
  }
  return problems;
}

const OUTPUT_REF = /needs\.changes\.outputs\.(?<name>[\w-]+)/gu;

/**
 * Split the workflow into the units a condition can occupy: one line, or a whole
 * block scalar (`if: >`, `filters: |`) folded back into one string under the
 * line number of its key.
 *
 * A per-line scan would read the fallback half of a folded `if:` as absent, so
 * the alternative was to ban folded conditions outright — but `publish-report`
 * has one for length alone, with no filter output in it. Joining the block costs
 * a few lines and refuses nothing that is fine.
 */
function scannableUnits(source) {
  const lines = source.split("\n");
  const units = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opener = /^(?<indent>\s*)[\w-]+:\s*[>|][-+]?\s*$/u.exec(lines[index]);
    if (!opener) {
      units.push({ line: index + 1, text: lines[index] });
      continue;
    }
    const keyIndent = opener.groups.indent.length;
    const body = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const next = lines[cursor];
      if (next.trim() !== "" && next.search(/\S/u) <= keyIndent) break;
      body.push(next);
    }
    units.push({ line: index + 1, text: `${lines[index]} ${body.join(" ")}` });
    index = cursor - 1;
  }
  return units;
}

/**
 * Reads of a `changes` output that do not carry the `all` fallback.
 *
 * Deliberately blind to WHICH construct does the reading: the bug this exists
 * for was in a `with:`, and every previous reading of this table had assumed
 * `if:` was the only place an output could be consumed.
 */
export function escapeHatchProblems(source) {
  const problems = [];
  for (const { line, text } of scannableUnits(source)) {
    const names = [...text.matchAll(OUTPUT_REF)].map(
      (match) => match.groups.name
    );
    if (names.length === 0 || names.includes("all")) continue;
    const named = [...new Set(names)].map((name) => `\`${name}\``).join(", ");
    problems.push(
      `ci.yml:${line} reads ${named} without \`|| needs.changes.outputs.all == 'true'\`. A \`workflow_dispatch\` run skips the paths-filter step, so that output is the empty string and the lane reports \`skipped\` — which \`check\` counts as a PASS. The one control that forces a full run would leave this lane unexercised and green.`
    );
  }
  return problems;
}

/** The repo-relative directory a glob claims, e.g. `packages/server/**` → `packages/server`. */
export function claimedPath(glob) {
  const withoutGlob = glob.replace(/\/\*\*.*$/u, "").replace(/\/\*$/u, "");
  return withoutGlob.replace(/\/+$/u, "");
}

/**
 * Every path a filter table claims, including ancestors: a filter naming
 * `packages/blueprints/apps/locker/**` claims `packages/blueprints` too, because
 * a change there does wake a lane.
 */
export function claimedPaths(filters) {
  const claimed = new Set();
  for (const globs of Object.values(filters)) {
    for (const glob of globs) {
      const target = claimedPath(glob);
      const parts = target.split("/");
      for (let depth = 1; depth <= parts.length; depth += 1) {
        claimed.add(parts.slice(0, depth).join("/"));
      }
    }
  }
  return claimed;
}

/**
 * The units a reader would expect a filter to name: each workspace package and
 * app, plus every tracked top-level directory.
 */
export function pathsRequiringClaim(trackedFiles) {
  const required = new Set();
  for (const file of trackedFiles) {
    const parts = file.split("/");
    if (parts.length < 2) continue; // a root file, not a directory
    if (parts[0] === "packages" || parts[0] === "apps") {
      if (parts.length >= 3) required.add(`${parts[0]}/${parts[1]}`);
      continue;
    }
    if (parts[0].startsWith(".")) continue; // .github, .governance, .githooks
    required.add(parts[0]);
  }
  return required;
}

export function lintPathFilters(filters, trackedFiles, ledger) {
  const errors = [...duplicateGlobs(filters)];

  const claimed = claimedPaths(filters);
  const required = pathsRequiringClaim(trackedFiles);
  const exempt = new Map(Object.entries(ledger.alwaysOn ?? {}));

  for (const target of [...required].sort()) {
    if (claimed.has(target)) continue;
    const reason = exempt.get(target);
    if (!reason) {
      errors.push(
        `\`${target}\` is claimed by no \`changes\` filter and has no ledger entry. A path no filter names wakes no path-gated lane, and \`skipped\` counts as a PASS in ci.yml's \`check\` — so it would merge green, unexercised. Add it to a filter, or record the always-on job that covers it in tests/path-filter-ledger.json.`
      );
      continue;
    }
    if (reason.length < 30) {
      errors.push(
        `ledger entry for \`${target}\` must name the always-on job that covers it, not just assert one`
      );
    }
  }

  for (const [target] of exempt) {
    if (!required.has(target)) {
      errors.push(
        `ledger entry for \`${target}\` names a path that is no longer in the tree — a stale exemption reads like a reviewed decision. Remove it.`
      );
    }
  }

  return errors;
}

function main() {
  const source = readFileSync(CI_PATH, "utf8");
  const filters = parseFilters(source);
  if (!filters || Object.keys(filters).length === 0) {
    console.error(
      "path-filters: could not read the `changes` filter table from ci.yml — refusing to pass without checking anything"
    );
    process.exitCode = 1;
    return;
  }
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  const ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));

  const errors = [
    ...lintPathFilters(filters, tracked, ledger),
    ...escapeHatchProblems(source),
  ];
  if (errors.length) {
    for (const error of errors) console.error(`path-filters: ${error}`);
    console.error(`path-filters: ${errors.length} problem(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `path-filters: ${Object.keys(filters).length} filter(s) cover every workspace and top-level path (${Object.keys(ledger.alwaysOn ?? {}).length} ledgered as always-on), and every read of one carries the \`all\` fallback`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
