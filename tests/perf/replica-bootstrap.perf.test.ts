import { recordQualityResult } from '@centraid/test-kit/quality-result';
import { generateVolumeFixture } from '@centraid/test-kit/volume-fixture';
import { expect, test } from 'vitest';
import { exerciseWindowedBootstrap } from '../quality/replica-bootstrap-fixture.js';

const OWNER = 'tests/perf/replica-bootstrap.perf.test.ts';

test('windowed replica bootstrap stays within its fixed-volume budget', async () => {
  const fixture = generateVolumeFixture({
    seed: 458,
    parties: 0,
    photos: 0,
    conversations: 0,
    replicaRows: 10_000,
  });
  const result = await exerciseWindowedBootstrap(fixture.replicaRows, 1_000);
  const passed = result.durationMs < 2_500 && result.rows === 10_000;
  await recordQualityResult({
    lane: 'perf',
    owner: OWNER,
    name: 'Replica bootstrap at 10k rows',
    status: passed ? 'passed' : 'failed',
    measurements: [{ name: 'wall clock', value: result.durationMs, unit: 'ms', budget: 2_500 }],
  });
  expect(result.rows).toBe(10_000);
  expect(result.durationMs).toBeLessThan(2_500);
});
