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
    'owner.latest.status',
    'duration(owner.latest.duration)',
    'report-data',
    '"status":"stale"',
  ]) {
    if (!html.includes(required)) throw new Error(`report missing ${required}`);
  }
  for (const owner of [
    'apps/desktop/tests/e2e/appview-templates-insights.spec.ts',
    'packages/client/src/replica/intents.contract.test.ts',
  ]) {
    if (!html.includes(`"latest":{"owner":"${owner}","status":"stale"`)) {
      throw new Error(`old green evidence did not turn stale for ${owner}`);
    }
  }
  console.log('test report smoke: ok');
} finally {
  await rm(temp, { recursive: true, force: true });
}
