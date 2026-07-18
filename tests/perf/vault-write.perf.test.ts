import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTestVault } from '@centraid/test-kit/factories';
import { recordQualityResult } from '@centraid/test-kit/quality-result';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { expect, test } from 'vitest';

const OWNER = 'tests/perf/vault-write.perf.test.ts';

test('journalled vault writes stay within the nightly latency budget', async () => {
  const db = await createTestVault();
  db.vault.exec('CREATE TABLE perf_write (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT');
  const statement = db.vault.prepare('INSERT INTO perf_write (value) VALUES (?)');
  const samples: number[] = [];
  for (let index = 0; index < 250; index += 1) {
    const started = performance.now();
    db.vault.exec('BEGIN IMMEDIATE');
    statement.run(`value-${index}`);
    db.vault.exec('COMMIT');
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const p95Ms = samples[Math.floor(samples.length * 0.95)] ?? Number.POSITIVE_INFINITY;
  const fsyncsPerWrite = await traceFsyncsPerWrite();
  const fsyncBudget = 4.5;
  const passed = p95Ms < 100 && (fsyncsPerWrite === undefined || fsyncsPerWrite <= fsyncBudget);
  await recordQualityResult({
    lane: 'perf',
    owner: OWNER,
    name: 'Vault write p95',
    status: passed ? 'passed' : 'failed',
    measurements: [
      { name: 'p95 transaction latency', value: p95Ms, unit: 'ms', budget: 100 },
      ...(fsyncsPerWrite === undefined
        ? []
        : [
            {
              name: 'fsyncs per write',
              value: fsyncsPerWrite,
              unit: 'calls/write',
              budget: fsyncBudget,
            },
          ]),
    ],
  });
  expect(p95Ms).toBeLessThan(100);
  if (fsyncsPerWrite !== undefined) expect(fsyncsPerWrite).toBeLessThanOrEqual(fsyncBudget);
});

async function traceFsyncsPerWrite(): Promise<number | undefined> {
  if (process.platform !== 'linux') return undefined;
  if (spawnSync('strace', ['--version'], { stdio: 'ignore' }).status !== 0) return undefined;
  const directory = await tempDir('vault-fsync-perf-');
  const tracePath = path.join(directory, 'fsync.trace');
  const databasePath = path.join(directory, 'vault.db');
  const writes = 100;
  const child = path.resolve('tests/perf/fixtures/vault-write-child.mjs');
  const result = spawnSync(
    'strace',
    [
      '-qq',
      '-f',
      '-e',
      'trace=fsync,fdatasync',
      '-o',
      tracePath,
      process.execPath,
      child,
      databasePath,
      String(writes),
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`strace fsync probe failed: ${result.stderr || result.stdout}`);
  }
  const trace = await readFile(tracePath, 'utf8');
  return (trace.match(/\b(?:fsync|fdatasync)\(/g)?.length ?? 0) / writes;
}
