#!/usr/bin/env node
// Parity: the runner being deleted and the runner replacing it, over real
// history (#1005).
//
// A port is a claim about behaviour, and the only honest evidence for it is the
// two implementations disagreeing nowhere. This replays both over the last N
// commits of the trunk: for each commit it checks out a scratch worktree,
// materialises the OLD four `check.sh` from the last revision that still had
// them, runs each one, then runs the NEW runner in the same tree, and compares
// verdict per directive.
//
// At an arbitrary historical commit the merge-base with the trunk IS that
// commit, so both runners take their "no base" path — the repo-state and
// HEAD-only paths. The range path is proven separately, on the current branch,
// with `--range-only`: there both runners see a real base.
//
// Usage:
//   node .governance/law/parity.mjs [--last N] [--range-only] [--quiet]
// Exit 1 on any disagreement.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** The four directives this port replaces, and the rule each became. */
export const PORTED = Object.freeze([
  "commit-message-format",
  "doc-integrity",
  "managed-tree-integrity",
  "receipt-per-issue",
]);

const PACK = ".governance/packs/governance-kit/audit";

/**
 * Disagreements that are decisions rather than regressions.
 *
 * A divergence is admissible only if it is written down with its reason. Every
 * other disagreement fails the replay, so this file can never quietly grow into
 * "whatever the new runner happens to do".
 *
 * @returns {{directive: string, old: string, new: string, reason: string}[]} The rows.
 */
export function expectedDivergences() {
  const file = path.join(import.meta.dirname, "parity-expectations.json");
  return JSON.parse(readFileSync(file, "utf8")).divergences;
}

/**
 * Is this disagreement one of the recorded divergences?
 *
 * @param {string} directive The directive id.
 * @param {number} oldStatus The old runner's exit code.
 * @param {number} newStatus The new runner's verdict as an exit code.
 * @returns {object|null} The matching row, or null.
 */
export function explainedBy(directive, oldStatus, newStatus) {
  const name = (status) => (status === 0 ? "pass" : status === 1 ? "fail" : "n/a");
  return (
    expectedDivergences().find(
      (row) =>
        row.directive === directive &&
        row.old === name(oldStatus) &&
        row.new === name(newStatus)
    ) ?? null
  );
}

/**
 * Run a command, returning its exit code and output rather than throwing.
 *
 * @param {string} file The executable.
 * @param {string[]} args Its arguments.
 * @param {string} cwd Where to run it.
 * @returns {{status: number, output: string}} The result.
 */
function run(file, args, cwd) {
  const result = execFileSync(file, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_INDEX_FILE: undefined },
  }).toString();
  return { status: 0, output: result };
}

/**
 * As `run`, but a non-zero exit is a verdict rather than an error.
 *
 * @param {string} file The executable.
 * @param {string[]} args Its arguments.
 * @param {string} cwd Where to run it.
 * @returns {{status: number, output: string}} The result.
 */
function verdict(file, args, cwd) {
  try {
    return run(file, args, cwd);
  } catch (error) {
    return {
      status: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

/**
 * The last revision at which the vendored pack still existed.
 *
 * Resolved rather than pinned, so this script keeps working after the deletion
 * commit lands: `rev-list -1` finds the commit that last TOUCHED the pack (the
 * deletion itself, once it exists), and its first parent is the revision that
 * still has it.
 *
 * @returns {string} A revision that contains the old runner.
 */
export function oldRunnerRevision() {
  const probe = `${PACK}/directives/commit-message-format/check.sh`;
  const last = execFileSync("git", ["rev-list", "-1", "HEAD", "--", probe], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  if (!last) throw new Error(`parity: no revision of ${probe} found in history`);
  const exists = (rev) => {
    try {
      execFileSync("git", ["cat-file", "-e", `${rev}:${probe}`], { cwd: ROOT, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  // Resolved to a real oid: `<sha>^` printed through a `slice(0, 8)` would read
  // as the deletion commit itself, which is the one revision that does NOT
  // have the old runner.
  return exists(last)
    ? last
    : execFileSync("git", ["rev-parse", `${last}^`], { cwd: ROOT, encoding: "utf8" }).trim();
}

/**
 * Materialise the old runner and its overlay into a tree.
 *
 * @param {string} tree The worktree to write into.
 * @param {string} rev The revision to take the old runner from.
 * @returns {void}
 */
function materialiseOldRunner(tree, rev) {
  const files = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", rev, "--", PACK, ".governance/conf/governance-kit"],
    { cwd: ROOT, encoding: "utf8" }
  )
    .split("\n")
    .filter(Boolean);
  for (const file of files) {
    const blob = execFileSync("git", ["cat-file", "blob", `${rev}:${file}`], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    const target = path.join(tree, file);
    execFileSync("mkdir", ["-p", path.dirname(target)]);
    writeFileSync(target, blob, { mode: file.endsWith(".sh") ? 0o755 : 0o644 });
  }
}

/**
 * Copy the new runner into a tree, so it resolves that tree as its root.
 *
 * @param {string} tree The worktree to write into.
 * @returns {void}
 */
function materialiseNewRunner(tree) {
  const destination = path.join(tree, ".governance/law");
  rmSync(destination, { recursive: true, force: true });
  cpSync(path.join(ROOT, ".governance/law"), destination, {
    recursive: true,
    filter: (source) => !source.includes("node_modules") && !source.endsWith("/out"),
  });
  symlinkSync(
    path.join(ROOT, ".governance/law/node_modules"),
    path.join(destination, "node_modules")
  );
}

/**
 * Both runners' verdicts in one tree.
 *
 * @param {string} tree The worktree.
 * @param {string} door Which door the new runner opens.
 * @returns {{old: Record<string, number>, next: Record<string, number>, output: object}} Verdicts.
 */
export function verdictsIn(tree, door = "window") {
  const old = {};
  for (const directive of PORTED) {
    const script = path.join(tree, PACK, "directives", directive, "check.sh");
    old[directive] = existsSync(script) ? verdict("bash", [script], tree).status : -1;
  }
  // Both runners must judge the same tree. The old one reads the worktree, and
  // this harness has just written the old pack and the new law INTO it, so the
  // injected files are staged and the new runner is pointed at the index
  // (R-1005-27) — otherwise it would read the commit, where neither runner
  // exists, and report a clean managed tree the shell directive never saw.
  execFileSync("git", ["add", "-A"], { cwd: tree, stdio: "ignore" });
  const result = verdict("node", [".governance/law/run.mjs", "--door", door, "--staged", "--json"], tree);
  let report = { rules: [] };
  try {
    report = JSON.parse(result.output.slice(result.output.indexOf("{"), result.output.lastIndexOf("}") + 1));
  } catch {
    report = { rules: [], crashed: result.output };
  }
  const next = Object.fromEntries(
    PORTED.map((id) => {
      const row = report.rules.find((rule) => rule.id === id);
      return [id, row ? (row.verdict === "pass" ? 0 : 1) : -1];
    })
  );
  return { old, next, output: report };
}

/**
 * Replay both runners over the last N trunk commits.
 *
 * @param {number} count How many commits.
 * @returns {{rows: object[], disagreements: object[]}} The table and the diffs.
 */
export function replay(count) {
  const commits = execFileSync(
    "git",
    ["rev-list", "--max-count", String(count), "origin/main"],
    { cwd: ROOT, encoding: "utf8" }
  )
    .split("\n")
    .filter(Boolean)
    .toReversed();
  return replayAt(commits);
}

/**
 * Replay both runners at each of the given revisions, in one scratch worktree.
 *
 * @param {string[]} commits The revisions, in the order to visit them.
 * @returns {{rows: object[], disagreements: object[], explained: object[], oldRunnerRevision: string}}
 *   The table and the diffs.
 */
export function replayAt(commits) {
  const rev = oldRunnerRevision();
  const scratch = mkdtempSync(path.join(tmpdir(), "law-parity-"));
  const tree = path.join(scratch, "tree");
  execFileSync("git", ["worktree", "add", "--detach", "-q", tree, commits[0]], { cwd: ROOT });
  const rows = [];
  const disagreements = [];
  const explainedRows = [];
  try {
    for (const sha of commits) {
      // Clean first: the previous iteration left the old runner and the law
      // materialised as untracked files, and checkout refuses to overwrite
      // them.
      execFileSync("git", ["clean", "-qfdx"], { cwd: tree });
      execFileSync("git", ["checkout", "-q", "--detach", "--force", sha], { cwd: tree });
      materialiseOldRunner(tree, rev);
      materialiseNewRunner(tree);
      const { old, next } = verdictsIn(tree);
      const row = { sha: sha.slice(0, 8), old, next };
      rows.push(row);
      for (const directive of PORTED) {
        if (old[directive] === next[directive]) continue;
        const explained = explainedBy(directive, old[directive], next[directive]);
        (explained ? explainedRows : disagreements).push({ ...row, directive, explained });
      }
    }
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", tree], { cwd: ROOT });
    rmSync(scratch, { recursive: true, force: true });
  }
  return { rows, disagreements, explained: explainedRows, oldRunnerRevision: rev };
}

/**
 * Render the table.
 *
 * @param {object[]} rows The replay rows.
 * @returns {string} A markdown table.
 */
export function renderTable(rows) {
  const cell = (value) => (value === 0 ? "pass" : value === 1 ? "FAIL" : "n/a");
  const lines = [
    `| commit | ${PORTED.map((id) => `${id} old/new`).join(" | ")} |`,
    `| --- | ${PORTED.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.sha} | ${PORTED.map((id) => `${cell(row.old[id])}/${cell(row.next[id])}`).join(" | ")} |`
    );
  }
  return lines.join("\n");
}

/**
 * The CLI.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {number} The exit code.
 */
export function main(argv) {
  if (argv.includes("--range-only")) {
    // The range path: a scratch worktree at HEAD, where the merge-base against
    // the trunk is real. History cannot exercise this half — at a historical
    // commit the merge-base IS that commit — and the working tree cannot run
    // the old checks any more, because they are deleted.
    const { rows, disagreements, explained } = replayAt(["HEAD"]);
    process.stdout.write(`${renderTable(rows)}\n`);
    process.stdout.write(
      `\nrange path at HEAD: ${disagreements.length} unexplained disagreement(s), ` +
        `${explained.length} recorded divergence(s)\n`
    );
    for (const row of disagreements) {
      process.stdout.write(
        `✗ ${row.sha} ${row.directive}: old=${row.old[row.directive]} new=${row.next[row.directive]}\n`
      );
    }
    return disagreements.length === 0 ? 0 : 1;
  }
  const index = argv.indexOf("--last");
  const count = index === -1 ? 50 : Number(argv[index + 1]);
  const { rows, disagreements, explained, oldRunnerRevision: rev } = replay(count);
  if (!argv.includes("--quiet")) process.stdout.write(`${renderTable(rows)}\n`);
  process.stdout.write(
    `\nold runner taken from ${rev.slice(0, 8)}; ${rows.length} commit(s) replayed; ` +
      `${disagreements.length} unexplained disagreement(s), ${explained.length} recorded divergence(s)\n`
  );
  for (const row of expectedDivergences()) {
    const hits = explained.filter((entry) => entry.directive === row.directive).length;
    process.stdout.write(`  divergence ${row.directive} ${row.old}→${row.new}: ${hits} commit(s)\n`);
  }
  for (const row of disagreements) {
    process.stdout.write(
      `✗ ${row.sha} ${row.directive}: old=${row.old[row.directive]} new=${row.next[row.directive]}\n`
    );
  }
  return disagreements.length === 0 ? 0 : 1;
}

if (process.argv[1] === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
