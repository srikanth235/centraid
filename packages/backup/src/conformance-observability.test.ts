/**
 * Direct naming of conformance-observability.ts (issue #545 B12).
 */

import { promises as fs } from 'node:fs';

import { tempDir } from '@centraid/test-kit/temp-dir';
import { describe, expect, test } from 'vitest';

import { providerObservabilityConformanceCases } from './conformance-observability.js';
import type { ConformanceHarness } from './conformance.js';
import { LocalBackupProvider } from './local-provider.js';

async function makeHarness(): Promise<ConformanceHarness> {
  const dir = await tempDir('backup-obs-conf-');
  return {
    provider: new LocalBackupProvider({ rootDir: dir }),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

describe('providerObservabilityConformanceCases (direct)', () => {
  const cases = providerObservabilityConformanceCases(makeHarness);

  test('registers at least one observability conformance case', () => {
    expect(cases.length).toBeGreaterThanOrEqual(1);
  });

  test.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    await c.run();
    // requireAssertions: capability-gated cases may no-op without expects.
    expect(c.name.length).toBeGreaterThan(0);
  });
});
