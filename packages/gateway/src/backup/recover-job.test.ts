import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * The daemon-owned recovery JOB model (issue #439 R1 wave 4). Drives the job
 * lifecycle with a DETERMINISTIC stand-in for `recover()` (injected `recoverFn`)
 * so timing is under the test's control — the real restore integration is
 * proved by `recover-live-e2e.test.ts`. Covers: a running job reaches `done`
 * with the report persisted and streamed; the event history replays for a late
 * subscriber; a second `start()` while one runs is refused; and — the
 * resumability contract — a job the previous daemon died mid-flight is found
 * `running` at next startup, marked `interrupted`, and its torn staging scratch
 * swept, all WITHOUT ever persisting the kit keyring or api-key.
 */

import { afterEach, expect, test } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  RecoverJobConflictError,
  RecoverJobRunner,
  type RecoverJobDeps,
  type RecoverJobEvent,
} from './recover-job.js';
import type { RecoverAdoptContext, RecoverPhase, RecoverReport } from './recover.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});
function makeReport(over: Partial<RecoverReport> = {}): RecoverReport {
  return {
    vaultId: 'vault-1',
    targetId: 'target-1',
    provider: 'https://home.example',
    vaultDir: '/tmp/vault/vault-1',
    seq: 3,
    generation: 2,
    recoveredAsOf: 1_700_000_000_000,
    truncated: false,
    skippedBlobs: 2,
    inventoryConsulted: true,
    restoreCostClass: 'free-egress',
    previews: {
      warmed: true,
      tiniesWarmed: 4,
      tiniesTotal: 4,
      tiniesFailed: 0,
      timeToUsableGridMs: 12,
    },
    reconcile: { checked: 2, missing: 0, repinned: [], lost: [] },
    quarantine: ['outbox', 'automations', 'connections'],
    ...over,
  };
}

/** A `recoverFn` that walks the given phases (via `onPhase`), calls `onAdopted`,
 *  exercises `resolveRemoteTier`, then resolves the report. */
function scriptedRecover(
  phases: RecoverPhase[],
  report: RecoverReport,
  hooks: { onAdoptCalled?: (ctx: RecoverAdoptContext) => void } = {},
): RecoverJobDeps['recoverFn'] {
  return async (input) => {
    for (const phase of phases) input.onPhase?.(phase);
    const ctx: RecoverAdoptContext = {
      vaultId: report.vaultId,
      vaultDir: report.vaultDir,
      targetId: report.targetId,
      // The job never touches these — a stand-in is fine for the type.
      provider: {} as never,
      keyring: {} as never,
    };
    hooks.onAdoptCalled?.(ctx);
    await input.onAdopted?.(ctx);
    await input.resolveRemoteTier?.(ctx);
    return report;
  };
}

async function makeRunner(over: Partial<RecoverJobDeps> = {}): Promise<{
  runner: RecoverJobRunner;
  dir: string;
  vaultRoot: string;
  adopted: string[];
}> {
  const dir = await tempDir('recover-job');
  const vaultRoot = await tempDir('recover-job-vaults');
  const adopted: string[] = [];
  const runner = new RecoverJobRunner({
    dir,
    vaultRoot,
    backupDir: await tempDir('recover-job-backup'),
    adopt: (vaultId) => adopted.push(vaultId),
    resolveRemoteTier: () => undefined,
    logger: silentLogger,
    recoverFn: scriptedRecover(['discovering', 'fetching', 'done'], makeReport()),
    ...over,
  });
  // Flush pending progress writes before the temp dirs are removed (a persist
  // enqueued by the terminal settle can still be in flight after `collect`).
  cleanups.push(() => runner.flush());
  return { runner, dir, vaultRoot, adopted };
}

/** Collect a job's events to a terminal (`done`/`failed`/`interrupted`). */
function collect(runner: RecoverJobRunner, jobId: string): Promise<RecoverJobEvent[]> {
  return new Promise((resolve) => {
    const seen: RecoverJobEvent[] = [];
    // Replay first (mirrors the SSE route), then go live.
    for (const ev of runner.snapshot(jobId)) seen.push(ev);
    if (seen.some((e) => e.kind !== 'phase')) return resolve(seen);
    const unsub = runner.subscribe(jobId, (ev) => {
      seen.push(ev);
      if (ev.kind !== 'phase') {
        unsub();
        resolve(seen);
      }
    });
  });
}

test('a job runs to done: phases emitted, adopt+warm wired, report persisted and streamed', async () => {
  const { runner, dir, adopted } = await makeRunner();
  const { jobId } = await runner.start({ kitDocument: { any: 'kit' }, apiKey: 'sk-test' });

  const events = await collect(runner, jobId);
  // Phase transitions arrived in order, then a terminal `done` carrying the report.
  expect(
    events.filter((e) => e.kind === 'phase').map((e) => (e as { phase: string }).phase),
  ).toEqual(['discovering', 'fetching', 'done']);
  const last = events.at(-1)!;
  expect(last.kind).toBe('done');
  if (last.kind === 'done') expect(last.report.vaultId).toBe('vault-1');

  // The live mount seam fired.
  expect(adopted).toEqual(['vault-1']);

  const record = runner.currentRecord()!;
  expect(record.state).toBe('done');
  expect(record.vaultId).toBe('vault-1');
  expect(record.targetId).toBe('target-1');
  expect(record.report?.seq).toBe(3);

  // Persisted metadata carries the report but NEVER a secret.
  await runner.flush();
  const raw = await fs.readFile(path.join(dir, 'recover-job.json'), 'utf8');
  expect(raw).not.toContain('sk-test');
  expect(raw).not.toContain('keyring');
  const persisted = JSON.parse(raw) as { state: string; report: { vaultId: string } };
  expect(persisted.state).toBe('done');
  expect(persisted.report.vaultId).toBe('vault-1');
});

test('a late subscriber replays the full phase history', async () => {
  const { runner } = await makeRunner();
  const { jobId } = await runner.start({ kitDocument: {}, apiKey: 'k' });
  await collect(runner, jobId); // drive to done
  const replay = runner.snapshot(jobId);
  expect(replay.map((e) => e.kind)).toEqual(['phase', 'phase', 'phase', 'done']);
});

test('a second start while one runs is refused (409 conflict)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { runner } = await makeRunner({
    recoverFn: async (input) => {
      input.onPhase?.('discovering');
      await gate; // stays running until released
      return makeReport();
    },
  });
  const first = await runner.start({ kitDocument: {}, apiKey: 'k' });
  expect(first.jobId).toBeTruthy();
  await expect(runner.start({ kitDocument: {}, apiKey: 'k' })).rejects.toBeInstanceOf(
    RecoverJobConflictError,
  );
  release();
  await collect(runner, first.jobId);
  expect(runner.currentRecord()!.state).toBe('done');
});

test('a job the previous daemon died mid-flight is marked interrupted and its staging swept', async () => {
  const dir = await tempDir('recover-job-crash');
  const vaultRoot = await tempDir('recover-job-crash-vaults');
  // Simulate the crash: a persisted `running` record + a torn staging dir.
  await fs.writeFile(
    path.join(dir, 'recover-job.json'),
    JSON.stringify({
      jobId: 'crashed-job',
      state: 'running',
      phase: 'fetching',
      startedAt: 1,
      updatedAt: 2,
      vaultId: 'vault-x',
      targetId: 'target-x',
    }),
  );
  const staging = path.join(vaultRoot, '.recover-staging-deadbeef');
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(path.join(staging, 'vault.db'), 'torn');

  const runner = new RecoverJobRunner({
    dir,
    vaultRoot,
    backupDir: await tempDir('recover-job-crash-backup'),
    adopt: () => undefined,
    resolveRemoteTier: () => undefined,
    logger: silentLogger,
  });
  await runner.init();

  const record = runner.currentRecord()!;
  expect(record.jobId).toBe('crashed-job');
  expect(record.state).toBe('interrupted');
  // The torn staging scratch is gone; the terminal event is available to a
  // client that reattaches to the interrupted job.
  expect(existsSync(staging)).toBe(false);
  expect(runner.snapshot('crashed-job').map((e) => e.kind)).toEqual(['interrupted']);

  // The flip persisted, so a further restart still reports interrupted (not running).
  const persisted = JSON.parse(await fs.readFile(path.join(dir, 'recover-job.json'), 'utf8')) as {
    state: string;
  };
  expect(persisted.state).toBe('interrupted');
});

test('a terminal record from a prior process is loaded as-is (not re-flipped)', async () => {
  const { runner: first, dir } = await makeRunner();
  const started = await first.start({ kitDocument: {}, apiKey: 'k' });
  await collect(first, started.jobId);
  await first.flush();
  expect(first.currentRecord()!.state).toBe('done');

  // A fresh runner over the SAME dir loads the completed record unchanged.
  const second = new RecoverJobRunner({
    dir,
    vaultRoot: await tempDir('recover-job-reload-vaults'),
    backupDir: await tempDir('recover-job-reload-backup'),
    adopt: () => undefined,
    resolveRemoteTier: () => undefined,
    logger: silentLogger,
  });
  await second.init();
  expect(second.currentRecord()!.state).toBe('done');
});
