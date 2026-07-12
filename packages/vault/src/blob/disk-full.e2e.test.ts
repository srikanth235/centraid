/*
 * REAL disk-full round-trip (issue #351 wave 4). The rest of this package's
 * disk-full coverage (../errors.test.ts) induces failures via `PRAGMA
 * max_page_count` (a genuine SQLITE_FULL — no sqlite mocking) or, for the
 * blob-cleanup unit test only, an injected `writeSync` failure (ESM's
 * `node:fs` can't be `vi.spyOn`-ed per-export, and reliably filling a real
 * filesystem needs the same disk-image dance as here). This test closes
 * that last gap: `FsBlobStore.putSync` against an ACTUAL full filesystem —
 * a tiny (5 MiB) APFS volume, attached via `hdiutil` — so the failure is a
 * genuine kernel ENOSPC, not a simulation.
 *
 * Gated behind `CENTRAID_DISKFULL_E2E=1` (darwin only, skips otherwise) —
 * it shells out to `hdiutil create`/`attach`/`detach` and leaves scratch
 * files under `os.tmpdir()`, always cleaned up (detach + rm) in a `finally`
 * even when an assertion throws.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { VaultDiskFullError } from '../errors.js';
import { FsBlobStore } from './local.js';

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

test('FsBlobStore.putSync against a REAL full filesystem: ENOSPC, no leftover tmp file, VaultDiskFullError', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('disk-full e2e only runs on darwin (hdiutil)');
    return;
  }
  if (process.env.CENTRAID_DISKFULL_E2E !== '1') {
    t.skip('set CENTRAID_DISKFULL_E2E=1 (on darwin) to run the real hdiutil disk-full e2e');
    return;
  }

  const work = mkdtempSync(path.join(tmpdir(), 'centraid-diskfull-e2e-'));
  const image = path.join(work, 'diskfull.dmg');
  const mount = path.join(work, 'mnt');
  mkdirSync(mount, { recursive: true });
  let attached = false;

  try {
    execFileSync('hdiutil', [
      'create',
      '-size',
      '5m',
      '-fs',
      'APFS',
      '-volname',
      'CentraidDiskFullE2E',
      '-quiet',
      image,
    ]);
    execFileSync('hdiutil', ['attach', image, '-mountpoint', mount, '-nobrowse']);
    attached = true;

    const store = new FsBlobStore(mount);
    // Fill the volume with distinct 1 MiB blobs until one write genuinely
    // ENOSPCs (the volume is 5 MiB total, so this reliably fails well
    // before 64 writes).
    let failure: unknown;
    for (let i = 0; i < 64 && failure === undefined; i++) {
      const sha = i.toString(16).padStart(64, '0');
      const bytes = Buffer.alloc(1024 * 1024, i);
      try {
        store.putSync(sha, bytes);
      } catch (err) {
        failure = err;
      }
    }

    expect(failure).toBeDefined();
    expect(failure).toBeInstanceOf(VaultDiskFullError);
    expect((failure as VaultDiskFullError).context).toBe('blob CAS write');

    // No stray `.tmp` file anywhere under the fan-out tree — the failed
    // write's temp file was cleaned up before the error propagated.
    const strayTmp = listFilesRecursive(mount).filter((f) => f.endsWith('.tmp'));
    expect(strayTmp).toEqual([]);
  } finally {
    if (attached) {
      try {
        execFileSync('hdiutil', ['detach', mount, '-force']);
      } catch {
        /* best-effort — a leaked test volume from a killed run is a known cost */
      }
    }
    rmSync(work, { recursive: true, force: true });
  }
});
