import { describe, expect, test } from 'vitest';
import {
  cellsMissingRatchet,
  detectDefaultCiEnvGate,
  extractUnhandledErrors,
  filterFloorConfigEntries,
  findUnmappedEvidence,
  mergeLaneMarkers,
  reconcileJobConclusions,
  summarizeCellStates,
} from './report-signals.mjs';
import { validateMatrix } from './validate-matrix.mjs';
import {
  REPORT_COMMENT_MARKER,
  coverageScopesBelowFloor,
  publicReportUrl,
  renderSummaryMarkdown,
} from './summary-markdown.mjs';

describe('extractUnhandledErrors', () => {
  test('reads explicit unhandledErrors array from vitest JSON', () => {
    const messages = extractUnhandledErrors({
      success: false,
      unhandledErrors: [{ message: 'write EPIPE' }, 'other'],
      testResults: [
        {
          status: 'passed',
          assertionResults: [{ status: 'passed' }],
        },
      ],
    });
    expect(messages).toContain('write EPIPE');
    expect(messages).toContain('other');
  });

  test('flags success=false with zero failed tests (EPIPE-class process fail)', () => {
    const messages = extractUnhandledErrors({
      success: false,
      testResults: [
        {
          status: 'passed',
          assertionResults: [{ status: 'passed' }, { status: 'passed' }],
        },
      ],
    });
    expect(messages.some((m) => /success=false|unhandled/i.test(m))).toBe(true);
  });

  test('does not invent errors when suite genuinely failed assertions', () => {
    const messages = extractUnhandledErrors({
      success: false,
      testResults: [
        {
          status: 'failed',
          assertionResults: [{ status: 'failed', fullName: 'x' }],
        },
      ],
    });
    expect(messages.every((m) => !/zero failed tests/i.test(m))).toBe(true);
  });
});

describe('summarizeCellStates', () => {
  test('separates failed from missing (lane ran vs not run)', () => {
    const counts = summarizeCellStates([
      { state: 'passed' },
      { state: 'failed' },
      { state: 'failed' },
      { state: 'missing' },
      { state: 'missing' },
      { state: 'missing' },
      { state: 'skipped' },
    ]);
    expect(counts.cellsFailed).toBe(2);
    expect(counts.cellsMissing).toBe(3);
    expect(counts.cellsPassed).toBe(1);
    expect(counts.cellsSkipped).toBe(1);
  });
});

describe('detectDefaultCiEnvGate', () => {
  test('detects describe.skipIf(process.env.X !== "1") whole-file gates', () => {
    const src = `import { describe } from 'vitest';
describe.skipIf(process.env.CENTRAID_RUN_NATIVE_TUNNEL !== '1')('native gateway relay', () => {
  test('x', () => {});
});
`;
    expect(detectDefaultCiEnvGate(src)).toEqual({
      env: 'CENTRAID_RUN_NATIVE_TUNNEL',
      kind: 'skipIf-env-not-1',
    });
  });

  test('detects env check + t.skip in the test body (disk-full pattern)', () => {
    const src = `
test('FsBlobStore.putSync against a REAL full filesystem', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('disk-full e2e only runs on darwin (hdiutil)');
    return;
  }
  if (process.env.CENTRAID_DISKFULL_E2E !== '1') {
    t.skip('set CENTRAID_DISKFULL_E2E=1 (on darwin) to run the real hdiutil disk-full e2e');
    return;
  }
  expect(true).toBe(true);
});
`;
    expect(detectDefaultCiEnvGate(src)).toEqual({
      env: 'CENTRAID_DISKFULL_E2E',
      kind: 'early-env-return',
    });
  });

  test('returns null for ordinary tests', () => {
    expect(detectDefaultCiEnvGate(`test('works', () => { expect(1).toBe(1); });`)).toBeNull();
  });
});

describe('renderSummaryMarkdown', () => {
  test('renders health table and report marker', () => {
    const md = renderSummaryMarkdown(
      {
        passed: 10,
        failed: 1,
        cellsFailed: 2,
        cellsMissing: 3,
        unhandledErrors: 1,
        unhandledErrorMessages: ['write EPIPE'],
        coverageBelowFloor: ['packages/gateway/**'],
        validationErrorCount: 0,
        generatedAt: '2026-07-19T00:00:00.000Z',
      },
      { reportUrl: 'https://example.test/report/', runUrl: 'https://example.test/run/1' },
    );
    expect(md).toContain('needs attention');
    expect(md).toContain('| Evidence failed | 1 |');
    expect(md).toContain('https://example.test/report/');
    expect(md).toContain(REPORT_COMMENT_MARKER);
    expect(md).toContain('write EPIPE');
  });

  test('marks ok when all signals clean', () => {
    const md = renderSummaryMarkdown({
      passed: 5,
      failed: 0,
      cellsFailed: 0,
      cellsMissing: 1,
      unhandledErrors: 0,
      coverageBelowFloor: [],
      validationErrorCount: 0,
    });
    expect(md).toContain('**Status:** ok');
  });
});

describe('coverageScopesBelowFloor', () => {
  test('lists scopes under line floor only', () => {
    expect(
      coverageScopesBelowFloor([
        { scope: 'a', lines: 50, lineFloor: 60 },
        { scope: 'b', lines: 90, lineFloor: 80 },
        { scope: 'c', lines: null, lineFloor: 70 },
      ]),
    ).toEqual(['a']);
  });
});

describe('publicReportUrl', () => {
  test('builds project pages URL', () => {
    expect(publicReportUrl({ owner: 'srikanth235', repo: 'centraid', slot: 'main' })).toBe(
      'https://srikanth235.github.io/centraid/test-report/main/',
    );
  });
});

describe('findUnmappedEvidence', () => {
  test('counts orphaned e2e results and separates failed unmapped', () => {
    const matrix = {
      cellOwners: {
        'mobile.journey': { owner: 'tests/agent-e2e-mobile/flows/home-loads.mjs', tier: 'e2e' },
      },
      flows: [],
    };
    const results = [
      { owner: 'tests/agent-e2e-mobile/flows/home-loads.mjs', status: 'passed' },
      { owner: 'tests/agent-e2e-mobile/flows/template-gate.mjs', status: 'failed' },
      { owner: 'tests/orphan/no-owner.mjs', status: 'passed' },
    ];
    const found = findUnmappedEvidence(results, matrix);
    expect(found.unmappedEvidence).toBe(2);
    expect(found.failedUnmapped.map((r) => r.owner)).toEqual([
      'tests/agent-e2e-mobile/flows/template-gate.mjs',
    ]);
  });

  test('treats flow owners as registered', () => {
    const matrix = {
      cellOwners: { 'mobile.journey': null },
      flows: [
        {
          id: 'mobile-template-gate',
          owner: 'tests/agent-e2e-mobile/flows/template-gate.mjs',
        },
      ],
    };
    const found = findUnmappedEvidence(
      [{ owner: 'tests/agent-e2e-mobile/flows/template-gate.mjs', status: 'failed' }],
      matrix,
    );
    expect(found.unmappedEvidence).toBe(0);
    expect(found.failedUnmapped).toEqual([]);
  });
});

describe('reconcileJobConclusions', () => {
  test('flags silent all-clear when needs jobs failed but summary.failed is 0', () => {
    const recon = reconcileJobConclusions(
      {
        'desktop-e2e': { result: 'success' },
        'mobile-e2e': { result: 'failure' },
        'mobile-e2e-android': { result: 'failure' },
      },
      { failed: 0 },
    );
    expect(recon.silentAllClear).toBe(true);
    expect(recon.failedJobs).toEqual(['mobile-e2e', 'mobile-e2e-android']);
    expect(recon.message).toMatch(/mobile-e2e/);
  });

  test('is quiet when failed evidence already accounts for the red jobs', () => {
    const recon = reconcileJobConclusions({ 'mobile-e2e': { result: 'failure' } }, { failed: 2 });
    expect(recon.silentAllClear).toBe(false);
    expect(recon.message).toBeNull();
  });
});

describe('cellsMissingRatchet', () => {
  test('detects grey creep vs prior durable history point', () => {
    const ratchet = cellsMissingRatchet(18, [
      { label: '2026-07-20', cellsMissing: 12 },
      { label: '2026-07-21', cellsMissing: 15 },
    ]);
    expect(ratchet.prior).toBe(15);
    expect(ratchet.current).toBe(18);
    expect(ratchet.delta).toBe(3);
    expect(ratchet.rose).toBe(true);
  });

  test('does not flag improvement or first run', () => {
    expect(cellsMissingRatchet(10, [{ cellsMissing: 15 }]).rose).toBe(false);
    expect(cellsMissingRatchet(10, []).rose).toBe(false);
  });
});

describe('filterFloorConfigEntries', () => {
  test('drops _comment and non-scope meta keys', () => {
    const entries = filterFloorConfigEntries({
      _comment: 'seed floors',
      approvedDeviation: { reason: 'x' },
      lines: 70,
      'packages/gateway/**': { lines: 80 },
    });
    expect(entries.map(([k]) => k).sort()).toEqual(['lines', 'packages/gateway/**']);
  });
});

describe('mergeLaneMarkers', () => {
  test('merges per-lane shards without last-write-win loss', () => {
    expect(
      mergeLaneMarkers([
        { 'desktop-playwright': '2026-07-24T01:00:00.000Z' },
        { 'web-playwright': '2026-07-24T02:00:00.000Z' },
        { 'desktop-playwright': '2026-07-24T03:00:00.000Z' },
      ]),
    ).toEqual({
      'desktop-playwright': '2026-07-24T03:00:00.000Z',
      'web-playwright': '2026-07-24T02:00:00.000Z',
    });
  });
});

describe('validateMatrix skip notes (#535)', () => {
  test('fails when a skip cell has no matrix.notes rationale', async () => {
    const matrix = {
      dimensions: [{ id: 'journey', label: 'Journey', lane: 'e2e' }],
      surfaces: [{ id: 'mobile', label: 'Mobile', assessment: { journey: 'skip' } }],
      cellOwners: { 'mobile.journey': null },
      flows: [],
      notes: {},
    };
    const { errors } = await validateMatrix(matrix, { checkFiles: false });
    expect(errors.some((e) => e.includes('mobile.journey') && e.includes('matrix.notes'))).toBe(
      true,
    );
  });

  test('accepts a skip cell with a one-line note', async () => {
    const matrix = {
      dimensions: [{ id: 'journey', label: 'Journey', lane: 'e2e' }],
      surfaces: [{ id: 'mobile', label: 'Mobile', assessment: { journey: 'skip' } }],
      cellOwners: { 'mobile.journey': null },
      flows: [],
      notes: { 'mobile.journey': 'Delegated to consuming surface; no native journey surface.' },
    };
    const { errors } = await validateMatrix(matrix, { checkFiles: false });
    expect(errors.filter((e) => e.includes('matrix.notes'))).toEqual([]);
  });
});
