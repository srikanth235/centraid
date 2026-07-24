import { describe, expect, test } from 'vitest';
import { fc } from '@centraid/test-kit/fast-check';
import { MemoryIntentStore } from './intent-store.js';
import { IntentQueue } from './intents.js';

const intentIdArb = fc
  .tuple(fc.integer({ min: 0, max: 1_000_000 }), fc.string({ minLength: 1, maxLength: 12 }))
  .map(([n, s]) => `intent-${n}-${s}`);

const payloadArb = fc.record({
  title: fc.string({ minLength: 1, maxLength: 48 }),
  nested: fc.record({
    seed: fc.integer({ min: 0, max: 10_000 }),
    parity: fc.constantFrom('even', 'odd'),
  }),
});

/**
 * Replica intent idempotency properties (#532).
 *
 * Model: same intentId + equal payload replays dedupe; same intentId with a
 * different payload fails closed; distinct intentIds never collide.
 */
describe('replica intent generated-payload property', () => {
  test('equal replays dedupe and mutated replays fail closed for every generated payload', async () => {
    await fc.assert(
      fc.asyncProperty(intentIdArb, payloadArb, async (intentId, input) => {
        const queue = new IntentQueue(new MemoryIntentStore());
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
      }),
      { numRuns: 40, seed: 53202 },
    );
  });

  test('distinct intentIds never collide even with equal payloads', async () => {
    await fc.assert(
      fc.asyncProperty(intentIdArb, intentIdArb, payloadArb, async (idA, idB, input) => {
        fc.pre(idA !== idB);
        const queue = new IntentQueue(new MemoryIntentStore());
        const a = await queue.enqueue({
          intentId: idA,
          appId: 'notes',
          action: 'create',
          input,
        });
        const b = await queue.enqueue({
          intentId: idB,
          appId: 'notes',
          action: 'create',
          input: structuredClone(input),
        });
        expect(a.intentId).toBe(idA);
        expect(b.intentId).toBe(idB);
        expect(await queue.list()).toHaveLength(2);
        queue.close();
      }),
      { numRuns: 32, seed: 53222 },
    );
  });

  test('triple equal replay still leaves a single queued intent', async () => {
    await fc.assert(
      fc.asyncProperty(intentIdArb, payloadArb, async (intentId, input) => {
        const queue = new IntentQueue(new MemoryIntentStore());
        const first = await queue.enqueue({
          intentId,
          appId: 'notes',
          action: 'create',
          input,
        });
        for (let i = 0; i < 2; i += 1) {
          const again = await queue.enqueue({
            intentId,
            appId: 'notes',
            action: 'create',
            input: structuredClone(input),
          });
          expect(again).toEqual(first);
        }
        expect(await queue.list()).toHaveLength(1);
        queue.close();
      }),
      { numRuns: 24, seed: 53223 },
    );
  });

  test('action field change with same intentId and input fails closed', async () => {
    await fc.assert(
      fc.asyncProperty(intentIdArb, payloadArb, async (intentId, input) => {
        const queue = new IntentQueue(new MemoryIntentStore());
        await queue.enqueue({ intentId, appId: 'notes', action: 'create', input });
        await expect(
          queue.enqueue({
            intentId,
            appId: 'notes',
            action: 'update',
            input: structuredClone(input),
          }),
        ).rejects.toThrow('reused with another payload');
        queue.close();
      }),
      { numRuns: 24, seed: 53224 },
    );
  });

  test('appId field change with same intentId and input fails closed', async () => {
    await fc.assert(
      fc.asyncProperty(intentIdArb, payloadArb, async (intentId, input) => {
        const queue = new IntentQueue(new MemoryIntentStore());
        await queue.enqueue({ intentId, appId: 'notes', action: 'create', input });
        await expect(
          queue.enqueue({
            intentId,
            appId: 'tasks',
            action: 'create',
            input: structuredClone(input),
          }),
        ).rejects.toThrow('reused with another payload');
        queue.close();
      }),
      { numRuns: 24, seed: 53225 },
    );
  });

  test('deep nested field tamper fails closed', async () => {
    await fc.assert(
      fc.asyncProperty(intentIdArb, payloadArb, async (intentId, input) => {
        const queue = new IntentQueue(new MemoryIntentStore());
        await queue.enqueue({ intentId, appId: 'notes', action: 'create', input });
        await expect(
          queue.enqueue({
            intentId,
            appId: 'notes',
            action: 'create',
            input: {
              ...input,
              nested: { ...input.nested, seed: input.nested.seed + 1 },
            },
          }),
        ).rejects.toThrow('reused with another payload');
        queue.close();
      }),
      { numRuns: 24, seed: 53226 },
    );
  });

  test('N distinct intents yield N list entries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(intentIdArb, { minLength: 2, maxLength: 8 }),
        payloadArb,
        async (ids, input) => {
          const queue = new IntentQueue(new MemoryIntentStore());
          for (const intentId of ids) {
            await queue.enqueue({
              intentId,
              appId: 'notes',
              action: 'create',
              input: { ...input, title: `${input.title}-${intentId}` },
            });
          }
          expect(await queue.list()).toHaveLength(ids.length);
          queue.close();
        },
      ),
      { numRuns: 20, seed: 53227 },
    );
  });

  test('replay after list still returns the original intent identity', async () => {
    await fc.assert(
      fc.asyncProperty(intentIdArb, payloadArb, async (intentId, input) => {
        const queue = new IntentQueue(new MemoryIntentStore());
        const first = await queue.enqueue({
          intentId,
          appId: 'notes',
          action: 'create',
          input,
        });
        const listed = await queue.list();
        expect(listed).toHaveLength(1);
        expect(listed[0]!.intentId).toBe(first.intentId);
        const replay = await queue.enqueue({
          intentId,
          appId: 'notes',
          action: 'create',
          input: structuredClone(input),
        });
        expect(replay.intentId).toBe(first.intentId);
        expect(replay.payloadHash).toBe(first.payloadHash);
        queue.close();
      }),
      { numRuns: 24, seed: 53228 },
    );
  });

  test('empty store starts empty and first enqueue length is one', async () => {
    await fc.assert(
      fc.asyncProperty(intentIdArb, payloadArb, async (intentId, input) => {
        const queue = new IntentQueue(new MemoryIntentStore());
        expect(await queue.list()).toHaveLength(0);
        await queue.enqueue({ intentId, appId: 'notes', action: 'create', input });
        expect(await queue.list()).toHaveLength(1);
        queue.close();
      }),
      { numRuns: 16, seed: 53229 },
    );
  });

  test('structuredClone of input is treated as equal for dedupe', async () => {
    await fc.assert(
      fc.asyncProperty(intentIdArb, payloadArb, async (intentId, input) => {
        const queue = new IntentQueue(new MemoryIntentStore());
        const first = await queue.enqueue({
          intentId,
          appId: 'notes',
          action: 'create',
          input: structuredClone(input),
        });
        const second = await queue.enqueue({
          intentId,
          appId: 'notes',
          action: 'create',
          input: structuredClone(input),
        });
        expect(second).toEqual(first);
        queue.close();
      }),
      { numRuns: 20, seed: 53230 },
    );
  });
});
