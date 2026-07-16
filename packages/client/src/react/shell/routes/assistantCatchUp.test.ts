import { describe, expect, it } from 'vitest';
import { catchUpAfterDrop } from './assistantCatchUp.js';

const instantSleep = (): Promise<void> => Promise.resolve();

describe('catchUpAfterDrop (#420)', () => {
  it('resolves true once turnCount climbs past the baseline', async () => {
    let calls = 0;
    const settled = await catchUpAfterDrop({
      baselineTurnCount: 3,
      getStatus: () => {
        calls += 1;
        // Turn lands on the 3rd poll.
        return Promise.resolve({ turnCount: calls >= 3 ? 4 : 3, updatedAt: 0 });
      },
      sleep: instantSleep,
    });
    expect(settled).toBe(true);
    expect(calls).toBe(3);
  });

  it('resolves false on timeout when the turn never settles', async () => {
    const settled = await catchUpAfterDrop({
      baselineTurnCount: 1,
      getStatus: () => Promise.resolve({ turnCount: 1, updatedAt: 0 }),
      timeoutMs: 0,
      sleep: instantSleep,
    });
    expect(settled).toBe(false);
  });

  it('keeps polling through transient status errors', async () => {
    let calls = 0;
    const settled = await catchUpAfterDrop({
      baselineTurnCount: 0,
      getStatus: () => {
        calls += 1;
        if (calls < 2) return Promise.reject(new Error('network'));
        return Promise.resolve({ turnCount: 1, updatedAt: 0 });
      },
      sleep: instantSleep,
    });
    expect(settled).toBe(true);
    expect(calls).toBe(2);
  });

  it('bails immediately when cancelled', async () => {
    let calls = 0;
    const settled = await catchUpAfterDrop({
      baselineTurnCount: 0,
      isCancelled: () => true,
      getStatus: () => {
        calls += 1;
        return Promise.resolve({ turnCount: 5, updatedAt: 0 });
      },
      sleep: instantSleep,
    });
    expect(settled).toBe(false);
    expect(calls).toBe(0);
  });
});
