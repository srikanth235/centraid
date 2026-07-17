import { describe, expect, it, vi } from 'vitest';

import type { NativeReplicaSession } from '../replica/native-session';
import { replaySettledUploadFollowups } from './followup';
import type { UploadQueue } from './native-queue';
import type { UploadFollowup } from './store';

vi.mock('./derivatives-native', () => ({
  contributeDeviceDerivatives: vi.fn(),
  cleanupDeviceDerivatives: vi.fn(),
}));

function followupOf(overrides: Partial<UploadFollowup> = {}): UploadFollowup {
  return {
    followupId: 7,
    intentId: 'upload-followup-item-1-stable',
    itemId: 'item-1',
    shape: 'docs',
    action: 'upload',
    input: { staged_sha: 'a'.repeat(64), title: 'Field notes' },
    attempts: 0,
    ...overrides,
  };
}

/** A queue double whose follow-up list and poison ledger are plain arrays. */
function fakeQueue(pending: UploadFollowup[]) {
  const cleared: number[] = [];
  const poisoned: { id: number; reason: string }[] = [];
  const attempts = new Map<number, number>();
  const queue = {
    pendingFollowups: () => pending.filter((f) => !poisoned.some((p) => p.id === f.followupId)),
    clearFollowup: (id: number) => {
      cleared.push(id);
      const index = pending.findIndex((f) => f.followupId === id);
      if (index >= 0) pending.splice(index, 1);
    },
    countFollowupAttempt: (id: number) => {
      const next = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, next);
      return next;
    },
    poisonFollowup: (id: number, reason: string) => poisoned.push({ id, reason }),
  } as unknown as UploadQueue;
  return { queue, cleared, poisoned, attempts };
}

function okSession(): { session: NativeReplicaSession; writes: string[] } {
  const writes: string[] = [];
  const session = {
    write: vi.fn(async (_shape, input) => {
      writes.push(input.intentId!);
      return { intentId: input.intentId!, status: 'executed' as const };
    }),
  } as unknown as NativeReplicaSession;
  return { session, writes };
}

describe('settled upload follow-ups', () => {
  it('replays the same intent id after a kill between execution and ledger clearing', async () => {
    const followup = followupOf();
    let pending = [followup];
    let killBeforeFirstClear = true;
    const queue = {
      pendingFollowups: () => pending,
      clearFollowup: () => {
        if (killBeforeFirstClear) {
          killBeforeFirstClear = false;
          throw new Error('simulated process death after execution');
        }
        pending = [];
      },
      countFollowupAttempt: () => 1,
      poisonFollowup: () => undefined,
    } as unknown as UploadQueue;
    const writes: string[] = [];
    const createdDocuments = new Set<string>();
    const session = {
      write: vi.fn(async (_shape, input) => {
        writes.push(input.intentId!);
        createdDocuments.add(input.intentId!);
        return { intentId: input.intentId!, status: 'executed' as const };
      }),
    } as unknown as NativeReplicaSession;

    // The kill lands on the FIRST clear; the record is not cleared, so the next
    // pass replays the same intent (idempotent) rather than losing the work.
    await replaySettledUploadFollowups(queue, session, 'http://gateway');
    await expect(replaySettledUploadFollowups(queue, session, 'http://gateway')).resolves.toEqual({
      replayed: 1,
      poisoned: 0,
    });

    expect(writes).toEqual([followup.intentId, followup.intentId]);
    expect(createdDocuments.size, 'the canonical document is created once').toBe(1);
    expect(pending).toEqual([]);
  });

  it('isolates a poison-payload follow-up so the rest still replay (F4)', async () => {
    const poison = followupOf({ followupId: 1, intentId: 'poison', input: { title: 'no sha' } });
    const good = followupOf({
      followupId: 2,
      intentId: 'good',
      input: { staged_sha: 'b'.repeat(64), title: 'ok' },
    });
    const { queue, poisoned } = fakeQueue([poison, good]);
    const { session, writes } = okSession();

    // Five passes: the poison never clears, but `good` replays on the first
    // pass and is gone thereafter; by pass five the poison is quarantined.
    let last = { replayed: 0, poisoned: 0 };
    for (let pass = 0; pass < 5; pass += 1) {
      last = await replaySettledUploadFollowups(queue, session, 'http://gateway');
    }

    expect(writes, 'the healthy record replayed exactly once').toEqual(['good']);
    expect(poisoned).toEqual([{ id: 1, reason: expect.stringMatching(/staged_sha/) }]);
    expect(last.poisoned).toBe(1);
  });

  it('poisons a follow-up whose canonical write keeps failing, without blocking others', async () => {
    const flaky = followupOf({ followupId: 1, intentId: 'flaky' });
    const { queue, poisoned } = fakeQueue([flaky]);
    const session = {
      write: vi.fn(async () => {
        throw new Error('replica rejected the write');
      }),
    } as unknown as NativeReplicaSession;

    for (let pass = 0; pass < 5; pass += 1) {
      await replaySettledUploadFollowups(queue, session, 'http://gateway');
    }
    expect(poisoned).toEqual([{ id: 1, reason: expect.stringMatching(/replica rejected/) }]);
  });
});
