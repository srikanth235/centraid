import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTestVault } from '@centraid/test-kit/factories';
import { recordQualityResult } from '@centraid/test-kit/quality-result';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { expect, test } from 'vitest';

const OWNER = 'tests/perf/vault-write.perf.test.ts';

// --- Budgets ---------------------------------------------------------------
// Latency baseline (2026-07-19, darwin arm64, on-disk WAL + synchronous=FULL,
// 250 core_party commits): p50 0.26 ms, p95 0.70 ms, max 3.0 ms. This write is
// fsync-bound, so a Pi-class / CI disk runs it 2–3× slower (baseline ~2 ms).
// Budget = ~3× that CI-representative baseline = 6 ms. Falsifiable: a real
// regression (double-syncing, journal.db receipt per write, synchronous flip)
// pushes p95 well past 6 ms while staying clear of disk jitter.
const LATENCY_BUDGET_MS = 6;
// Fsync baseline: WAL + synchronous=FULL fsyncs the -wal on each COMMIT, so the
// steady-state single-DB commit cost is ~1 fdatasync/write (open + bootstrap
// syncs amortize toward zero over 500 writes). The known low-end defect was
// "4 fsyncs/write"; this ceiling sits BELOW 4 so a regression to it fails, and
// above the ~1–2 WAL+FULL steady state so the honest current path passes. The
// exact count is measured by the Linux strace path below and recorded each run.
const FSYNC_BUDGET = 3;
const FSYNC_TRACE_WRITES = 500;

test('journalled vault writes stay within the nightly latency and fsync budget', async () => {
  // Measure latency against a REAL vault (createTestVault === openVaultDb +
  // bootstrapVault, on-disk WAL + FULL) writing a canonical ontology table so
  // the durable replica-protocol triggers fire in-transaction — a genuine
  // journalled write, not a bare INSERT into an ad-hoc table.
  const db = await createTestVault();
  const statement = db.vault.prepare(
    `INSERT INTO core_party
       (party_id, kind, display_name, created_at, updated_at, ontology_version)
     VALUES (?, 'person', ?, ?, ?, '1.2')`,
  );
  const samples: number[] = [];
  for (let index = 0; index < 250; index += 1) {
    const started = performance.now();
    db.vault.exec('BEGIN IMMEDIATE');
    statement.run(`perf-${index}`, `Perf party ${index}`, index, index);
    db.vault.exec('COMMIT');
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const p95Ms = samples[Math.floor(samples.length * 0.95)] ?? Number.POSITIVE_INFINITY;

  const fsyncsPerWrite = await traceFsyncsPerWrite();
  const passed =
    p95Ms < LATENCY_BUDGET_MS && (fsyncsPerWrite === undefined || fsyncsPerWrite <= FSYNC_BUDGET);
  await recordQualityResult({
    lane: 'perf',
    owner: OWNER,
    name: 'Vault write p95 and fsync budget',
    status: passed ? 'passed' : 'failed',
    measurements: [
      { name: 'p95 transaction latency', value: p95Ms, unit: 'ms', budget: LATENCY_BUDGET_MS },
      ...(fsyncsPerWrite === undefined
        ? []
        : [
            {
              name: 'fsyncs per write',
              value: fsyncsPerWrite,
              unit: 'calls/write',
              budget: FSYNC_BUDGET,
            },
          ]),
    ],
  });
  expect(p95Ms).toBeLessThan(LATENCY_BUDGET_MS);
  if (fsyncsPerWrite !== undefined) expect(fsyncsPerWrite).toBeLessThanOrEqual(FSYNC_BUDGET);
});

/**
 * Count fsync/fdatasync per write on the REAL vault write path via strace.
 *
 * SQLite issues its commit syncs from C (fdatasync on Linux, fcntl F_FULLFSYNC
 * on macOS), so a node:fs monkey-patch cannot observe them and named ESM
 * imports snapshot anyway — a syscall tracer is the only honest counter. strace
 * exists on Linux; the nightly perf lane installs it (.github/workflows/e2e.yml).
 *
 * Off Linux (darwin dev boxes) the fsync assertion cannot run, so it is skipped
 * and only latency is asserted. In CI on Linux a missing strace is a HARD
 * failure — silently returning `undefined` there would let the fsync gate
 * guard nothing, which is the defect this reorg closes.
 */
async function traceFsyncsPerWrite(): Promise<number | undefined> {
  const straceAvailable =
    process.platform === 'linux' &&
    spawnSync('strace', ['--version'], { stdio: 'ignore' }).status === 0;
  if (!straceAvailable) {
    if (process.env.CI && process.platform === 'linux') {
      throw new Error(
        `${OWNER}: strace is required to measure vault fsyncs/write in Linux CI ` +
          `but is unavailable; refusing to skip the fsync gate into a false green.`,
      );
    }
    return undefined;
  }
  const directory = await tempDir('vault-fsync-perf-');
  const tracePath = path.join(directory, 'fsync.trace');
  const vaultDir = path.join(directory, 'vault');
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
      vaultDir,
      String(FSYNC_TRACE_WRITES),
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`strace fsync probe failed: ${result.stderr || result.stdout}`);
  }
  const trace = await readFile(tracePath, 'utf8');
  const syncs = trace.match(/\b(?:fsync|fdatasync)\(/g)?.length ?? 0;
  return syncs / FSYNC_TRACE_WRITES;
}
