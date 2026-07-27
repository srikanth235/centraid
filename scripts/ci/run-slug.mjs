#!/usr/bin/env node
/**
 * Resolve the immutable report slot for an Actions run (#557).
 *
 * `test-report/nightly/` is a MUTABLE alias — tomorrow's publish overwrites it,
 * so anything citing only that link silently starts describing a different run.
 * Every publish is therefore also archived to `runs/<date>-<runId>/`, and both
 * the publish job and the failure-issue job have to derive *the same* slug or
 * the tracking issue links to a 404.
 *
 * That coupling used to be two hand-copied shell blocks in e2e.yml with a
 * comment asking the reader to keep them in sync. It is one implementation now.
 *
 * The date comes from the run's `created_at`, not `date` at publish time: a
 * re-publish of the same run (a re-run hours later, or a run that straddles
 * midnight UTC) must land in the slot it already has.
 *
 * Usage:  node scripts/ci/run-slug.mjs --repo owner/name --run-id 123
 * Writes `date=` and `slug=` to $GITHUB_OUTPUT, and prints them to stdout.
 */
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** GitHub returns an ISO-8601 timestamp; we key the slot on the UTC date. */
export function toRunDate(createdAt, fallbackNow) {
  const candidate = String(createdAt ?? '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) {
    // Reject a well-shaped but impossible date (e.g. 2026-13-45) — silently
    // publishing to a nonsense slot is worse than falling back.
    const parsed = new Date(`${candidate}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate) {
      return candidate;
    }
  }
  return fallbackNow.toISOString().slice(0, 10);
}

export function toSlug(date, runId) {
  return `${date}-${runId}`;
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const repo = flag('repo');
  const runId = flag('run-id');
  if (!repo || !runId) throw new Error('--repo and --run-id are required');

  // Best-effort: a rate-limited or offline `gh` must not fail the alert path.
  const probe = spawnSync(
    'gh',
    ['api', `repos/${repo}/actions/runs/${runId}`, '--jq', '.created_at'],
    {
      encoding: 'utf8',
    },
  );
  const createdAt = probe.status === 0 ? probe.stdout.trim() : '';

  const date = toRunDate(createdAt, new Date());
  const slug = toSlug(date, runId);

  console.log(`date=${date}`);
  console.log(`slug=${slug}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `date=${date}\nslug=${slug}\n`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('run-slug.mjs')) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
