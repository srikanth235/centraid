import { describe, expect, test } from 'vitest';
import { MemoryIntentStore } from './intent-store.js';
import { IntentQueue } from './intents.js';

function generatedPayload(seed: number): {
  title: string;
  nested: { seed: number; parity: string };
} {
  return {
    title: `generated-${seed.toString(36)}`,
    nested: { seed, parity: seed % 2 === 0 ? 'even' : 'odd' },
  };
}

describe('replica intent generated-payload property', () => {
  test('equal replays dedupe and mutated replays fail closed for every generated payload', async () => {
    for (let seed = 0; seed < 64; seed += 1) {
      const queue = new IntentQueue(new MemoryIntentStore());
      const intentId = `intent-${seed}`;
      const input = generatedPayload(seed);
      const first = await queue.enqueue({ intentId, appId: 'notes', action: 'create', input });
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
    }
  });
});
