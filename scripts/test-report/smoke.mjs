import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const temp = await mkdtemp(path.join(os.tmpdir(), 'centraid-report-'));
const output = path.join(temp, 'index.html');
try {
  const perf = path.join(temp, 'perf');
  const playwright = path.join(temp, 'playwright');
  const vitest = path.join(temp, 'vitest.json');
  const markers = path.join(temp, 'lane-starts.json');
  await Promise.all([mkdir(perf), mkdir(playwright)]);
  await writeFile(
    path.join(perf, 'stale-vault-write.json'),
    JSON.stringify({
      lane: 'perf',
      owner: 'tests/perf/vault-write.perf.test.ts',
      name: 'stale fixture',
      status: 'passed',
      measurements: [],
      history: [{ at: '2000-01-01T00:00:00.000Z', value: 1 }],
    }),
  );
  await writeFile(
    path.join(playwright, 'desktop-playwright.json'),
    JSON.stringify({
      stats: { startTime: '2000-01-01T00:00:00.000Z' },
      suites: [
        {
          file: 'apps/desktop/tests/e2e/appview-templates-insights.spec.ts',
          specs: [{ tests: [{ results: [{ status: 'passed', duration: 4_242 }] }] }],
        },
      ],
    }),
  );
  await writeFile(
    vitest,
    JSON.stringify({
      startTime: Date.parse('2000-01-01T00:00:00.000Z'),
      testResults: [
        {
          name: 'packages/client/src/replica/intents.contract.test.ts',
          status: 'passed',
          startTime: Date.parse('2000-01-01T00:00:00.000Z'),
          endTime: Date.parse('2000-01-01T00:00:01.000Z'),
          assertionResults: [],
        },
      ],
    }),
  );
  const currentRun = new Date().toISOString();
  await writeFile(
    markers,
    JSON.stringify({
      perf: currentRun,
      vitest: currentRun,
      'desktop-playwright': currentRun,
    }),
  );
  execFileSync(
    process.execPath,
    [
      'scripts/test-report/generate.mjs',
      '--output',
      output,
      '--perf',
      perf,
      '--playwright',
      playwright,
      '--vitest',
      vitest,
      '--lane-markers',
      markers,
    ],
    { stdio: 'inherit' },
  );
  await access(output);
  const html = await readFile(output, 'utf8');
  for (const required of [
    'Surface × quality dimension',
    'Coverage vs ratchet floor',
    'environment-gated',
    'cells not run',
    'unhandled errors',
    'failed (ran)',
    'owner.latest.status',
    'duration(owner.latest.duration)',
    'report-data',
    '"status":"stale"',
    'Environment-gated matrix owners',
  ]) {
    if (!html.includes(required)) throw new Error(`report missing ${required}`);
  }
  const summaryJson = path.join(path.dirname(output), 'summary.json');
  const summaryMd = path.join(path.dirname(output), 'summary.md');
  await access(summaryJson);
  await access(summaryMd);
  const summary = JSON.parse(await readFile(summaryJson, 'utf8'));
  if (typeof summary.cellsFailed !== 'number' || typeof summary.cellsMissing !== 'number') {
    throw new Error('summary.json missing cell honesty fields');
  }
  if (!Array.isArray(summary.coverageBelowFloor)) {
    throw new Error('summary.json missing coverageBelowFloor');
  }
  const md = await readFile(summaryMd, 'utf8');
  if (!md.includes('Test health') || !md.includes('<!-- centraid-test-health-report -->')) {
    throw new Error('summary.md missing marker or title');
  }
  for (const owner of [
    'apps/desktop/tests/e2e/appview-templates-insights.spec.ts',
    'packages/client/src/replica/intents.contract.test.ts',
  ]) {
    if (!html.includes(`"latest":{"owner":"${owner}","status":"stale"`)) {
      throw new Error(`old green evidence did not turn stale for ${owner}`);
    }
  }

  // Unhandled-error signal: success=false + zero failed assertions (EPIPE class).
  const { extractUnhandledErrors, summarizeCellStates } = await import('./report-signals.mjs');
  const unhandled = extractUnhandledErrors({
    success: false,
    unhandledErrors: [{ message: 'write EPIPE' }],
    testResults: [{ status: 'passed', assertionResults: [{ status: 'passed' }] }],
  });
  if (!unhandled.includes('write EPIPE')) {
    throw new Error('extractUnhandledErrors missed explicit unhandledErrors');
  }
  const cellCounts = summarizeCellStates([
    { state: 'failed' },
    { state: 'missing' },
    { state: 'missing' },
  ]);
  if (cellCounts.cellsFailed !== 1 || cellCounts.cellsMissing !== 2) {
    throw new Error('summarizeCellStates must separate failed from missing');
  }

  const {
    REPORT_COMMENT_MARKER,
    coverageScopesBelowFloor,
    publicReportUrl,
    renderSummaryMarkdown,
  } = await import('./summary-markdown.mjs');
  if (
    publicReportUrl({ owner: 'o', repo: 'r', slot: 'main' }) !==
    'https://o.github.io/r/test-report/main/'
  ) {
    throw new Error('publicReportUrl shape wrong');
  }
  if (coverageScopesBelowFloor([{ scope: 'x', lines: 10, lineFloor: 20 }]).join() !== 'x') {
    throw new Error('coverageScopesBelowFloor missed under-floor scope');
  }
  const summaryMdBody = renderSummaryMarkdown(
    { failed: 1, unhandledErrors: 0, cellsFailed: 0, cellsMissing: 0, coverageBelowFloor: [] },
    { reportUrl: 'https://example.test/' },
  );
  if (
    !summaryMdBody.includes(REPORT_COMMENT_MARKER) ||
    !summaryMdBody.includes('https://example.test/')
  ) {
    throw new Error('renderSummaryMarkdown missing marker or URL');
  }
  const noPublicUrl = renderSummaryMarkdown({
    failed: 0,
    unhandledErrors: 0,
    cellsFailed: 0,
    cellsMissing: 0,
    coverageBelowFloor: [],
  });
  if (!noPublicUrl.includes('main (and nightly)')) {
    throw new Error('renderSummaryMarkdown should note main-only public HTML when no reportUrl');
  }

  const badVitest = path.join(temp, 'vitest-unhandled.json');
  await writeFile(
    badVitest,
    JSON.stringify({
      success: false,
      startTime: Date.parse(currentRun),
      unhandledErrors: [{ message: 'write EPIPE' }],
      testResults: [
        {
          name: 'packages/example/x.test.ts',
          status: 'passed',
          startTime: Date.parse(currentRun),
          endTime: Date.parse(currentRun) + 5,
          assertionResults: [{ status: 'passed' }],
        },
      ],
    }),
  );
  const unhandledOut = path.join(temp, 'unhandled.html');
  execFileSync(
    process.execPath,
    [
      'scripts/test-report/generate.mjs',
      '--output',
      unhandledOut,
      '--vitest',
      badVitest,
      '--lane-markers',
      markers,
      '--perf',
      perf,
      '--playwright',
      playwright,
    ],
    { stdio: 'inherit' },
  );
  const unhandledHtml = await readFile(unhandledOut, 'utf8');
  if (!unhandledHtml.includes('Unhandled Vitest errors')) {
    throw new Error('report did not surface unhandled Vitest errors banner');
  }
  if (!unhandledHtml.includes('write EPIPE')) {
    throw new Error('report did not include unhandled error message');
  }
  console.log('test report smoke: ok');
} finally {
  await rm(temp, { recursive: true, force: true });
}
