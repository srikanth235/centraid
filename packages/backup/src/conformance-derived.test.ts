/**
 * Direct naming of conformance-derived.ts (issue #545 B12).
 * Runs the derived cases against LocalBackupProvider (same as the suite spread).
 */

import { tempDir } from '@centraid/test-kit/temp-dir';
import { promises as fs } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { providerDerivedConformanceCases } from './conformance-derived.js';
import type { ConformanceHarness } from './conformance.js';
import { LocalBackupProvider } from './local-provider.js';

async function makeHarness(): Promise<ConformanceHarness> {
  const dir = await tempDir('backup-derived-conf-');
  return {
    provider: new LocalBackupProvider({ rootDir: dir }),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

describe('providerDerivedConformanceCases (direct)', () => {
  const cases = providerDerivedConformanceCases(makeHarness);
  expect(cases.length).toBeGreaterThanOrEqual(3);
  for (const c of cases) {
    test(c.name, async () => {
      await c.run();
      expect(true).toBe(true);
    });
  }
});
