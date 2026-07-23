import { describe, expect, test } from 'vitest';
import {
  evaluateDiffCoverage,
  groupUncoveredHunks,
  isInstrumentableSource,
  lineHits,
  parseUnifiedDiffAddedLines,
  scoreDiffCoverage,
} from './diff-coverage.mjs';

const sampleDiff = `diff --git a/packages/vault/src/foo.ts b/packages/vault/src/foo.ts
--- a/packages/vault/src/foo.ts
+++ b/packages/vault/src/foo.ts
@@ -10,0 +11,3 @@
+const a = 1;
+const b = 2;
+const c = 3;
diff --git a/packages/vault/src/foo.test.ts b/packages/vault/src/foo.test.ts
--- a/packages/vault/src/foo.test.ts
+++ b/packages/vault/src/foo.test.ts
@@ -1,0 +2,1 @@
+test('x', () => {});
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,0 +2,1 @@
+hello
`;

describe('parseUnifiedDiffAddedLines', () => {
  test('extracts added line numbers for new-file side', () => {
    const map = parseUnifiedDiffAddedLines(sampleDiff);
    expect([...map.get('packages/vault/src/foo.ts')].sort((a, b) => a - b)).toEqual([11, 12, 13]);
    expect([...map.get('packages/vault/src/foo.test.ts')]).toEqual([2]);
  });
});

describe('isInstrumentableSource', () => {
  test('accepts package/app source, rejects tests and docs', () => {
    expect(isInstrumentableSource('packages/vault/src/foo.ts')).toBe(true);
    expect(isInstrumentableSource('apps/web/src/main.tsx')).toBe(true);
    expect(isInstrumentableSource('packages/vault/src/foo.test.ts')).toBe(false);
    expect(isInstrumentableSource('README.md')).toBe(false);
    expect(isInstrumentableSource('scripts/x.mjs')).toBe(false);
  });
});

describe('lineHits + scoreDiffCoverage', () => {
  test('scores covered vs uncovered changed lines from real comparison unit', () => {
    const coverageMap = {
      '/repo/packages/vault/src/foo.ts': {
        path: '/repo/packages/vault/src/foo.ts',
        statementMap: {
          0: { start: { line: 11, column: 0 }, end: { line: 11, column: 12 } },
          1: { start: { line: 12, column: 0 }, end: { line: 12, column: 12 } },
          2: { start: { line: 13, column: 0 }, end: { line: 13, column: 12 } },
        },
        s: { 0: 1, 1: 0, 2: 3 },
      },
    };
    expect(lineHits(coverageMap, 'packages/vault/src/foo.ts', 11)).toBe(1);
    expect(lineHits(coverageMap, 'packages/vault/src/foo.ts', 12)).toBe(0);
    expect(lineHits(coverageMap, 'packages/vault/src/foo.ts', 13)).toBe(3);

    const changed = parseUnifiedDiffAddedLines(sampleDiff);
    const score = scoreDiffCoverage(changed, coverageMap);
    // Only packages/vault/src/foo.ts counts (test file + README filtered).
    expect(score.total).toBe(3);
    expect(score.covered).toBe(2);
    expect(score.uncovered).toEqual([{ file: 'packages/vault/src/foo.ts', line: 12, hits: 0 }]);
    expect(score.percent).toBeCloseTo((2 / 3) * 100, 5);
  });
});

describe('evaluateDiffCoverage', () => {
  test('fails below threshold and names hunks', () => {
    const score = {
      total: 10,
      covered: 5,
      percent: 50,
      uncovered: [
        { file: 'packages/a/src/x.ts', line: 1 },
        { file: 'packages/a/src/x.ts', line: 2 },
        { file: 'packages/a/src/x.ts', line: 5 },
      ],
    };
    const result = evaluateDiffCoverage(score, 80, null);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/50\.0% < 80%/);
    expect(result.messages.some((m) => m.includes('packages/a/src/x.ts:1-2'))).toBe(true);
  });

  test('passes at threshold and with approvedDeviation', () => {
    const score = {
      total: 10,
      covered: 8,
      percent: 80,
      uncovered: [],
    };
    expect(evaluateDiffCoverage(score, 80, null).ok).toBe(true);
    expect(
      evaluateDiffCoverage(
        { total: 10, covered: 1, percent: 10, uncovered: [{ file: 'a.ts', line: 1 }] },
        80,
        'temporary large refactor #999',
      ).ok,
    ).toBe(true);
  });

  test('passes when no instrumentable lines changed', () => {
    expect(
      evaluateDiffCoverage({ total: 0, covered: 0, percent: 100, uncovered: [] }, 80, null).ok,
    ).toBe(true);
  });
});

describe('groupUncoveredHunks', () => {
  test('collapses consecutive lines', () => {
    const hunks = groupUncoveredHunks([
      { file: 'a.ts', line: 1 },
      { file: 'a.ts', line: 2 },
      { file: 'a.ts', line: 4 },
    ]);
    expect(hunks).toEqual([
      { file: 'a.ts', start: 1, end: 2, count: 2 },
      { file: 'a.ts', start: 4, end: 4, count: 1 },
    ]);
  });
});
