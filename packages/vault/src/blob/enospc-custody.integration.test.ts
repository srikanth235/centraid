import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Always-on fault-injected ENOSPC custody proof (#496 P4 / B1).
 *
 * Owns `blob-custody.durability`. Injects an ENOSPC-shaped `writeSync` failure
 * at the FsBlobStore boundary so default CI proves: fail closed, no partial
 * blob claim, typed VaultDiskFullError. The real hdiutil disk image path stays
 * in `disk-full.integration.test.ts` behind CENTRAID_DISKFULL_E2E=1 (darwin).
 */
import { tempDirSync } from '@centraid/test-kit/temp-dir';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { VaultDiskFullError } from '../errors.js';
import { FsBlobStore } from './local.js';

let writeSyncShouldFail = false;
vi.mock(import('node:fs'), async (importOriginal) => {
  // No type argument on importOriginal: passing the module as `import(...)`
  // already types it, and restating `typeof import('node:fs')` here conflicts
  // with the inferred namespace (which carries a synthetic `default`).
  const actual = await importOriginal();
  return {
    ...actual,
    // `Parameters<typeof actual.writeSync>` only captures the last overload
    // of node:fs's heavily-overloaded `writeSync`, so this replacement isn't
    // structurally assignable to the real (overloaded) type — assert it on
    // this one property rather than widen the whole module.
    writeSync: ((...args: Parameters<typeof actual.writeSync>) => {
      if (writeSyncShouldFail) {
        throw Object.assign(new Error('no space left on device'), {
          code: 'ENOSPC',
        });
      }
      return actual.writeSync(...args);
    }) as typeof actual.writeSync,
  };
});

describe('enospc-custody', () => {
  afterEach(() => {
    writeSyncShouldFail = false;
  });

  test('ENOSPC on putSync: VaultDiskFullError, no custody claim, no leftover tmp', async () => {
    const dir = tempDirSync('enospc-custody-');
    const store = new FsBlobStore(dir);
    const sha = 'c'.repeat(64);
    writeSyncShouldFail = true;
    expect(() => store.putSync(sha, Buffer.from('payload-bytes'))).toThrow(VaultDiskFullError);
    // No partial blob under the fanout path.
    const fanoutDir = path.join(dir, 'sha256', sha.slice(0, 2));
    const leftover = existsSync(fanoutDir) ? readdirSync(fanoutDir) : [];
    expect(leftover).toStrictEqual([]);
    // has() must not claim custody of a failed write.
    await expect(store.has(sha)).resolves.toBe(false);
  });

  test('successful put after a failed ENOSPC still works on the same store', async () => {
    const dir = tempDirSync('enospc-recover-');
    const store = new FsBlobStore(dir);
    const failSha = 'd'.repeat(64);
    const okSha = 'e'.repeat(64);
    writeSyncShouldFail = true;
    expect(() => store.putSync(failSha, Buffer.from('nope'))).toThrow(VaultDiskFullError);
    writeSyncShouldFail = false;
    store.putSync(okSha, Buffer.from('ok-payload'));
    await expect(store.has(okSha)).resolves.toBe(true);
    await expect(store.has(failSha)).resolves.toBe(false);
  });
});
