#!/usr/bin/env node
/**
 * Workflow pin hygiene (#557).
 *
 * Three properties this repo relied on convention for, now mechanical:
 *
 *   1. Every third-party `uses:` is pinned to a 40-char commit SHA. A floating
 *      tag (`@v4`, `@stable`) is a mutable reference an upstream owner can
 *      repoint at will — worst in the two workflows holding NPM_TOKEN and GHCR
 *      push. Repo-local actions (`./.github/...`) and `docker://` images with an
 *      explicit tag are exempt.
 *
 *   2. No workflow hardcodes a Bun version. `packageManager` in package.json is
 *      the single source of truth; `.github/actions/setup-bun` reads it at run
 *      time. 35 hand-copied literals happened to agree, but nothing said they
 *      had to.
 *
 *   3. Every job declares `timeout-minutes`. Without it a hung job inherits
 *      GitHub's 360-minute default and quietly burns the Actions budget.
 *
 * Offline, no dependencies, ~10ms — belongs on the per-PR loop next to the
 * other linters. Complements actionlint (which validates syntax/expressions,
 * not policy) rather than replacing it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = path.join(root, '.github/workflows');

const SHA_PINNED = /^[^@\s]+@[0-9a-f]{40}\s*(#.*)?$/;
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
  if (/^#\s*governance-kit:managed/m.test(source)) {
    console.log(`workflow-pins: ${name} is governance-kit:managed — policy is upstream, skipping`);
    return found;
  }

  let job = null;
  /** @type {{name: string, line: number, hasTimeout: boolean}[]} */
  const jobs = [];
  let inJobs = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNo = index + 1;
    const trimmed = line.trim();

    if (/^jobs:\s*$/.test(line)) inJobs = true;
    // A job key is exactly two-space indented under `jobs:`.
    if (inJobs && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) {
      job = { name: trimmed.slice(0, -1), line: lineNo, hasTimeout: false };
      jobs.push(job);
    }
    if (job && /^ {4}timeout-minutes:/.test(line)) job.hasTimeout = true;

    // (1) SHA pinning.
    const uses = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line);
    if (uses) {
      const ref = uses[1];
      if (!exemptUses(ref) && !SHA_PINNED.test(`${ref} ${trimmed.split('#')[1] ?? ''}`.trim())) {
        if (!/@[0-9a-f]{40}$/.test(ref)) {
          found.push(
            `${name}:${lineNo} uses a floating ref \`${ref}\` — pin to a 40-char SHA with a trailing \`# vX.Y.Z\` comment`,
          );
        }
      }
    }

    // (2) No literal Bun version.
    if (/^\s*bun-version:/.test(line)) {
      found.push(
        `${name}:${lineNo} hardcodes a Bun version — use \`uses: ./.github/actions/setup-bun\`, which reads packageManager`,
      );
    }
  }

  // (3) Every job bounded.
  for (const entry of jobs) {
    if (!entry.hasTimeout) {
      found.push(
        `${name}:${entry.line} job \`${entry.name}\` has no timeout-minutes (inherits GitHub's 360-minute default)`,
      );
    }
  }

  return found;
}

/** The composite action must itself resolve Bun from packageManager. */
function lintSetupBunAction() {
  const found = [];
  const actionPath = path.join(root, '.github/actions/setup-bun/action.yml');
  let source;
  try {
    source = readFileSync(actionPath, 'utf8');
  } catch {
    return ['.github/actions/setup-bun/action.yml is missing — workflows reference it'];
  }
  if (!source.includes('packageManager')) {
    found.push('.github/actions/setup-bun must derive the version from packageManager');
  }
  if (!/oven-sh\/setup-bun@[0-9a-f]{40}/.test(source)) {
    found.push('.github/actions/setup-bun must pin oven-sh/setup-bun to a SHA');
  }
  return found;
}

function lintPackageManager() {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!/^bun@\d+\.\d+\.\d+$/.test(pkg.packageManager ?? '')) {
    return [`package.json packageManager must be \`bun@<x.y.z>\`, got \`${pkg.packageManager}\``];
  }
  return [];
}

function main() {
  errors.push(...lintPackageManager(), ...lintSetupBunAction());

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
  console.log(`workflow-pins: ${files.length} workflow(s) clean (SHA pins, bun pin, timeouts)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
