#!/usr/bin/env node
/**
 * Workflow pin and layout hygiene (#557).
 *
 * Five properties this repo relied on convention for, now mechanical:
 *
 *   1. Every third-party `uses:` is pinned to a 40-char commit SHA. A floating
 *      tag (`@v4`, `@stable`) is a mutable reference an upstream owner can
 *      repoint at will — worst in the two workflows holding NPM_TOKEN and GHCR
 *      push. Repo-local actions (`./.github/...`) and `docker://` images with an
 *      explicit tag are exempt.
 *
 *   2. No workflow hardcodes a Bun version. `packageManager` in package.json is
 *      the single source of truth; `.github/actions/setup` reads it at run
 *      time. 35 hand-copied literals happened to agree, but nothing said they
 *      had to.
 *
 *   3. Every job declares `timeout-minutes`. Without it a hung job inherits
 *      GitHub's 360-minute default and quietly burns the Actions budget.
 *
 *   4. No workflow runs `bun install` by hand — `.github/actions/setup` does it
 *      behind `install:`. 33 copies of one line is how a `--frozen-lockfile`
 *      that gets dropped in one lane goes unnoticed.
 *
 *   5. `ci.yml` is the ONLY workflow that may listen on `pull_request`. This is
 *      the load-bearing one. A second PR-triggered workflow is not just untidy:
 *      because it needs path filters to be affordable, it can never be a
 *      required check (a filtered-out workflow reports nothing, and a required
 *      check that never reports blocks the PR forever). Ten such workflows is
 *      how eight lanes ended up unable to gate a merge. As jobs inside ci.yml
 *      they skip cleanly and roll up through the required `check`.
 *
 *   6. `release.yml` is the ONLY workflow that may listen on `push: tags`. Same
 *      shape, different trigger: four workflows watched the release tags
 *      independently, so cutting one tag produced four unrelated runs and no
 *      answer to "did the release work". A partial release — npm published,
 *      desktop packaging red — was three greens and a red in four places.
 *
 * Offline, no dependencies, ~10ms — belongs on the per-PR loop next to the
 * other linters. Complements actionlint (which validates syntax/expressions,
 * not policy) rather than replacing it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const workflowDir = path.join(root, '.github/workflows');

const SHA_PINNED = /^[^@\s]+@[0-9a-f]{40}\s*(?:#.*)?$/u;
const errors = [];

/** `uses:` values that are not third-party refs and so need no SHA. */
function exemptUses(ref) {
  // Repo-local composite/JS actions travel with the commit that uses them.
  if (ref.startsWith('./')) return true;
  // Container actions are pinned by image tag (actionlint validates the form).
  if (ref.startsWith('docker://')) return true;
  return false;
}

export function lintWorkflowSource(name, source) {
  const found = [];
  const lines = source.split('\n');

  // `# governance-kit:managed` files are vendored from the kit and integrity-
  // checked against a digest recorded at apply time (see the kit-runtime
  // directive). Editing one here breaks the trust chain and is reverted by the
  // next `governance update` anyway, so this repo cannot own their policy —
  // fixes belong upstream in governance-kit. Reported once, as a notice, so the
  // exemption stays visible rather than becoming an invisible hole.
  if (/^#\s*governance-kit:managed/mu.test(source)) {
    console.log(`workflow-pins: ${name} is governance-kit:managed — policy is upstream, skipping`);
    return found;
  }

  let job = null;
  /** @type {{name: string, line: number, hasTimeout: boolean, callsWorkflow: boolean}[]} */
  const jobs = [];
  let inJobs = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNo = index + 1;
    const trimmed = line.trim();

    if (/^jobs:\s*$/u.test(line)) inJobs = true;
    // A job key is exactly two-space indented under `jobs:`.
    if (inJobs && /^ {2}[A-Za-z0-9_-]+:\s*$/u.test(line)) {
      job = { name: trimmed.slice(0, -1), line: lineNo, hasTimeout: false, callsWorkflow: false };
      jobs.push(job);
    }
    if (job && /^ {4}timeout-minutes:/u.test(line)) job.hasTimeout = true;
    // A job-level `uses:` (4-space indent, vs a step's `      - uses:`) makes
    // this a reusable-workflow call. GitHub REJECTS timeout-minutes on those —
    // the bound lives on the called workflow's own jobs, which this linter
    // checks when it walks that file.
    if (job && /^ {4}uses:/u.test(line)) job.callsWorkflow = true;

    // (1) SHA pinning.
    const uses = /^\s*(?:-\s*)?uses:\s*(?<ref>\S+)/u.exec(line);
    if (uses) {
      const ref = uses.groups?.ref ?? '';
      if (!exemptUses(ref) && !SHA_PINNED.test(`${ref} ${trimmed.split('#')[1] ?? ''}`.trim())) {
        if (!/@[0-9a-f]{40}$/u.test(ref)) {
          found.push(
            `${name}:${lineNo} uses a floating ref \`${ref}\` — pin to a 40-char SHA with a trailing \`# vX.Y.Z\` comment`,
          );
        }
      }
    }

    // (2) No literal Bun version.
    if (/^\s*bun-version:/u.test(line)) {
      found.push(
        `${name}:${lineNo} hardcodes a Bun version — use \`uses: ./.github/actions/setup\`, which reads packageManager`,
      );
    }

    // (4) No hand-rolled install.
    if (/^\s*(?:-\s*)?(?:run:\s*)?bun install\b/u.test(line)) {
      found.push(
        `${name}:${lineNo} runs \`bun install\` by hand — use \`uses: ./.github/actions/setup\` (install is on by default)`,
      );
    }

    // (5) Single PR entry point.
    if (/^\s{2}pull_request:/u.test(line) && name !== '.github/workflows/ci.yml') {
      found.push(
        `${name}:${lineNo} listens on \`pull_request\` — only ci.yml may. Add a job there (gated on the \`changes\` filter) so it rolls up into the required \`check\`, or expose this workflow via \`workflow_call\` and invoke it from ci.yml`,
      );
    }

    // (6) Single release entry point. `tags:` sits at 4 spaces under `push:`,
    // which is itself under `on:` — and only in the header, so a `tags:` key
    // inside a job's `with:` map cannot be mistaken for a trigger.
    if (!inJobs && /^ {4}tags:/u.test(line) && name !== '.github/workflows/release.yml') {
      found.push(
        `${name}:${lineNo} listens on \`push: tags\` — only release.yml may. Expose this workflow via \`workflow_call\` and add a lane to release.yml so the tag produces one run with one \`release-check\` verdict`,
      );
    }
  }

  // (3) Every job bounded.
  for (const entry of jobs) {
    if (!entry.hasTimeout && !entry.callsWorkflow) {
      found.push(
        `${name}:${entry.line} job \`${entry.name}\` has no timeout-minutes (inherits GitHub's 360-minute default)`,
      );
    }
  }

  return found;
}

/** The composite action must itself resolve Bun from packageManager. */
function lintSetupAction() {
  const found = [];
  const actionPath = path.join(root, '.github/actions/setup/action.yml');
  let source;
  try {
    source = readFileSync(actionPath, 'utf8');
  } catch {
    return ['.github/actions/setup/action.yml is missing — workflows reference it'];
  }
  if (!source.includes('packageManager')) {
    found.push('.github/actions/setup must derive the version from packageManager');
  }
  if (!/oven-sh\/setup-bun@[0-9a-f]{40}/u.test(source)) {
    found.push('.github/actions/setup must pin oven-sh/setup-bun to a SHA');
  }
  return found;
}

function lintPackageManager() {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!/^bun@\d+\.\d+\.\d+$/u.test(pkg.packageManager ?? '')) {
    return [`package.json packageManager must be \`bun@<x.y.z>\`, got \`${pkg.packageManager}\``];
  }
  return [];
}

function main() {
  errors.push(...lintPackageManager(), ...lintSetupAction());

  const files = readdirSync(workflowDir)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort();
  for (const file of files) {
    const source = readFileSync(path.join(workflowDir, file), 'utf8');
    errors.push(...lintWorkflowSource(`.github/workflows/${file}`, source));
  }

  if (errors.length) {
    for (const error of errors) console.error(`workflow-pins: ${error}`);
    console.error(`workflow-pins: ${errors.length} problem(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `workflow-pins: ${files.length} workflow(s) clean (SHA pins, bun pin, timeouts, no hand-rolled install, single PR + release entry point)`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
