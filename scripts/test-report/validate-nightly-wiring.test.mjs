import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const e2ePath = path.join(root, '.github/workflows/e2e.yml');

/**
 * Structural unit tests for nightly wiring (#545 A9). Complements the
 * executable validate-nightly-wiring.mjs gate by asserting the #545 A1/A2
 * quality-outcome aggregator and mutation gating stay present.
 */
describe('validate-nightly-wiring structure (#545)', () => {
  const e2e = readFileSync(e2ePath, 'utf8');

  test('mutation-testing job does not use continue-on-error on Stryker', () => {
    const mutationBlock = e2e.slice(
      e2e.indexOf('mutation-testing:'),
      e2e.indexOf('test-health-report:'),
    );
    expect(mutationBlock).toMatch(/bun run test:mutation/);
    expect(mutationBlock).not.toMatch(/continue-on-error:\s*true\s*\n\s*# Upload/);
    // The Stryker step itself must not be continue-on-error.
    const strykerStep = mutationBlock.match(
      /name: Run Stryker[\s\S]*?(?=\n\s+- (?:name:|uses:)|$)/,
    );
    expect(strykerStep?.[0] ?? '').not.toMatch(/continue-on-error:\s*true/);
  });

  test('test-health-report re-reads coverage/perf/scale outcomes into failure (A1)', () => {
    expect(e2e).toMatch(/Fail if quality lanes failed/);
    expect(e2e).toMatch(/steps\.coverage\.outcome/);
    expect(e2e).toMatch(/steps\.perf\.outcome/);
    expect(e2e).toMatch(/steps\.scale\.outcome/);
  });

  test('nightly-failure-issue needs mutation-testing (A2)', () => {
    const failBlock = e2e.slice(e2e.indexOf('nightly-failure-issue:'));
    expect(failBlock).toMatch(/mutation-testing/);
    expect(failBlock).toMatch(/needs\.mutation-testing\.result/);
  });

  test('a failed issue create is loud, never swallowed (A11)', () => {
    // #557 moved the open-or-update logic out of four near-identical inline
    // shell blocks into scripts/ci/file-tracking-issue.mjs. The A11 invariant
    // is unchanged — a failed create must not be swallowed — so this asserts it
    // in both halves: the workflow delegates rather than hand-rolling `gh`, and
    // the script it delegates to exits non-zero. (The decision tree itself is
    // covered by scripts/ci/file-tracking-issue.test.mjs.)
    const failBlock = e2e.slice(e2e.indexOf('nightly-failure-issue:'));
    expect(failBlock).toMatch(/scripts\/ci\/file-tracking-issue\.mjs/);
    expect(failBlock).not.toMatch(/gh issue create/);
    expect(failBlock).not.toMatch(/gh issue create[^\n]*\|\|\s*true/);

    const filer = readFileSync(path.join(root, 'scripts/ci/file-tracking-issue.mjs'), 'utf8');
    expect(filer).toMatch(/::error::Failed to \$\{result\.action\} tracking issue/);
    expect(filer).toMatch(/process\.exitCode = 1/);
  });

  test('every workflow that files a tracking issue uses the shared filer', () => {
    // The four copies had already drifted before they were merged — one lost
    // its `--label` fallback, another swallowed every failure with
    // `|| echo "::warning::"`. Nothing is left to drift back apart.
    for (const workflow of ['e2e.yml', 'extension-e2e.yml', 'interop-weekly.yml']) {
      const source = readFileSync(path.join(root, '.github/workflows', workflow), 'utf8');
      expect(source, `${workflow} must not hand-roll gh issue create`).not.toMatch(
        /gh issue create/,
      );
      expect(source, `${workflow} must not hand-roll gh issue comment`).not.toMatch(
        /gh issue comment/,
      );
    }
  });
});
