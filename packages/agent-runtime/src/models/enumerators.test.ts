import { describe, expect, it } from 'vitest';
import type { RunnerKind } from '@centraid/app-engine';
import { enumerateRunnerModels } from './enumerators.js';

describe('enumerateRunnerModels', () => {
  it('returns [] for a runner kind with no enumerator', async () => {
    // Anything other than claude-code / codex has no control-plane catalog, so
    // the switchboard resolves to the empty default seed without spawning.
    const models = await enumerateRunnerModels({ kind: 'unknown' as RunnerKind });
    expect(models).toEqual([]);
  });
});
