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

  test('issue create failure emits ::error:: (A11)', () => {
    const failBlock = e2e.slice(e2e.indexOf('nightly-failure-issue:'));
    expect(failBlock).toMatch(/::error::Failed to create nightly tracking issue/);
    expect(failBlock).not.toMatch(/gh issue create[^\n]*\|\|\s*true/);
  });
});
