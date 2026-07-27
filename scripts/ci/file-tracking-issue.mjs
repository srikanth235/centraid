#!/usr/bin/env node
/**
 * Open-or-update a tracking issue for a red scheduled lane (#557).
 *
 * Three workflows filed tracking issues with near-identical inline shell —
 * e2e.yml (nightly), extension-e2e.yml (companion), interop-weekly.yml (backup
 * interop). "Near-identical" is the problem: the nightly copy had no
 * `--label` fallback, so on a repo without a `tech-debt` label it would have
 * behaved differently from the other two, and nobody would have known until a
 * nightly went red. Alerting code that only runs when something is already
 * broken has to be the least surprising code in the repo.
 *
 * Usage:
 *   node scripts/ci/file-tracking-issue.mjs \
 *     --title '[nightly] e2e lane red — tracking' \
 *     --search '[nightly] e2e lane red' \
 *     --body-file /tmp/body.md \
 *     [--label tech-debt] [--run-url https://...]
 *
 * Exits non-zero if the issue could not be filed. That is deliberate: a
 * swallowed `::warning::` here means a red lane with no trace anywhere, which
 * is the exact failure #556 was.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** Parse `--flag value` pairs. Unknown flags are an error, not a silent no-op. */
export function parseArgs(argv) {
  const known = new Set(['title', 'search', 'body-file', 'label', 'run-url']);
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument \`${token}\``);
    const key = token.slice(2);
    if (!known.has(key)) throw new Error(`unknown flag \`--${key}\``);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
    out[key] = value;
    index += 1;
  }
  for (const required of ['title', 'search', 'body-file']) {
    if (!out[required]) throw new Error(`--${required} is required`);
  }
  return out;
}

/**
 * `gh issue list --search` takes a raw search string. Restricting to `in:title`
 * and `--state open` is what keeps a closed issue from being resurrected and a
 * body mention from matching.
 */
export function buildSearchQuery(search) {
  return `in:title ${search}`;
}

/**
 * `gh ... --json number --jq '.[0].number'` prints an empty string for no match
 * and the literal `null` when the array is empty but well-formed. Both mean
 * "nothing found" — treating `"null"` as an issue number is how you end up
 * commenting on issue NaN.
 */
export function parseExistingNumber(stdout) {
  const trimmed = (stdout ?? '').trim();
  if (!trimmed || trimmed === 'null') return null;
  if (!/^\d+$/u.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * Comment on the matching open issue, or open a new one.
 *
 * @param {object} options Title/search/body plus the injected `gh` runner.
 * @param {(args: string[]) => {status: number|null, stdout: string, stderr: string}} options.run
 *   Invokes `gh` with the given argv. Injected so the whole decision tree is
 *   testable without a network or a repo.
 */
export function fileTrackingIssue({ run, title, search, body, label, runUrl }) {
  const found = run([
    'issue',
    'list',
    '--search',
    buildSearchQuery(search),
    '--state',
    'open',
    '--json',
    'number',
    '--jq',
    '.[0].number',
  ]);
  const existing = found.status === 0 ? parseExistingNumber(found.stdout) : null;

  if (existing !== null) {
    const commented = run(['issue', 'comment', String(existing), '--body', body]);
    if (commented.status !== 0) {
      return { ok: false, action: 'comment', number: existing, error: commented.stderr };
    }
    return { ok: true, action: 'comment', number: existing };
  }

  // Label first; a repo without that label must still get the issue, so fall
  // back to an unlabelled create rather than losing the alert.
  if (label) {
    const labelled = run(['issue', 'create', '--title', title, '--body', body, '--label', label]);
    if (labelled.status === 0) return { ok: true, action: 'create', labelled: true };
  }
  const plain = run(['issue', 'create', '--title', title, '--body', body]);
  if (plain.status !== 0) {
    return { ok: false, action: 'create', error: plain.stderr, runUrl };
  }
  return { ok: true, action: 'create', labelled: false };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const body = readFileSync(args['body-file'], 'utf8');
  const run = (argv) => {
    const result = spawnSync('gh', argv, { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };

  const result = fileTrackingIssue({
    run,
    title: args.title,
    search: args.search,
    body,
    label: args.label,
    runUrl: args['run-url'],
  });

  if (!result.ok) {
    const where = result.number ? ` #${result.number}` : '';
    console.error(
      `::error::Failed to ${result.action} tracking issue${where} — run ${args['run-url'] ?? '(unknown)'}`,
    );
    if (result.error) console.error(result.error);
    process.exitCode = 1;
    return;
  }
  if (result.action === 'comment') console.log(`Updated issue #${result.number}`);
  else
    console.log(
      `Opened tracking issue${result.labelled ? ' (labelled)' : ' (unlabelled fallback)'}`,
    );
}

if (process.argv[1] && process.argv[1].endsWith('file-tracking-issue.mjs')) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
