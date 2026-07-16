import { describe, expect, it, vi } from 'vitest';

import type { NativeReplicaSession } from '../replica/native-session';
import { replaySettledUploadFollowups } from './followup';
import type { UploadQueue } from './native-queue';
import type { UploadFollowup } from './store';

vi.mock('./derivatives-native', () => ({ contributeDeviceDerivatives: vi.fn() }));

describe('settled upload follow-ups', () => {
  it('replays the same intent id after a kill between execution and ledger clearing', async () => {
    const followup: UploadFollowup = {
      followupId: 7,
      intentId: 'upload-followup-item-1-stable',
      itemId: 'item-1',
      shape: 'docs',
      action: 'upload',
      input: { staged_sha: 'a'.repeat(64), title: 'Field notes' },
    };
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

    await expect(replaySettledUploadFollowups(queue, session, 'http://gateway')).rejects.toThrow(
      'simulated process death',
    );
    await expect(replaySettledUploadFollowups(queue, session, 'http://gateway')).resolves.toBe(1);

    expect(writes).toEqual([followup.intentId, followup.intentId]);
    expect(createdDocuments.size, 'the canonical document is created once').toBe(1);
    expect(pending).toEqual([]);
  });
});
