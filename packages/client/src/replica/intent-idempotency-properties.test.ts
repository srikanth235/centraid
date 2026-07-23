import { describe, expect, test } from 'vitest';
import { fc } from '@centraid/test-kit/fast-check';
import { MemoryIntentStore } from './intent-store.js';
import { IntentQueue } from './intents.js';

/**
 * Replica intent idempotency property (#532).
 *
 * Model: equal replays of the same intentId + payload dedupe to one queued
 * intent; a mutated payload on a reused intentId fails closed.
 */
describe('replica intent generated-payload property', () => {
  test('equal replays dedupe and mutated replays fail closed for every generated payload', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10_000 }),
        fc.string({ minLength: 1, maxLength: 48 }),
        fc.boolean(),
        async (seed, titleSuffix, evenParity) => {
          const queue = new IntentQueue(new MemoryIntentStore());
          const intentId = `intent-${seed}`;
          const input = {
            title: `generated-${seed.toString(36)}-${titleSuffix}`,
            nested: { seed, parity: evenParity ? 'even' : 'odd' },
          };
          const first = await queue.enqueue({
            intentId,
            appId: 'notes',
            action: 'create',
            input,
          });
          const replay = await queue.enqueue({
            intentId,
            appId: 'notes',
            action: 'create',
            input: structuredClone(input),
          });

          expect(replay).toEqual(first);
          expect(await queue.list()).toHaveLength(1);
          await expect(
            queue.enqueue({
              intentId,
              appId: 'notes',
              action: 'create',
              input: { ...input, title: `${input.title}-tampered` },
            }),
          ).rejects.toThrow('reused with another payload');
          queue.close();
        },
      ),
      { numRuns: 32, seed: 53202 },
    );
  });
});
