import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { fc } from '@centraid/test-kit/fast-check';
import type { ReplicaDigest } from './digest.js';
import { canonicalJson, intentPayloadHash } from './payload-hash.js';
import type { ReplicaValue } from './types.js';

const nodeDigest: ReplicaDigest = (input) =>
  Promise.resolve(createHash('sha256').update(input, 'utf8').digest('hex'));

/** JSON-safe finite values (no NaN/Infinity, which fail closed in the hasher). */
const jsonSafe: fc.Arbitrary<ReplicaValue> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }),
    fc.string({ maxLength: 24 }),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.stringMatching(/^[a-z]{1,8}$/), tie('value'), { maxKeys: 4 }),
  ),
})).value;

/**
 * Payload-hash properties (#532 core expansion — kills sort/key mutants).
 *
 * Model: canonical JSON is key-order independent; hash is pure over
 * (appId, action, input); non-finite numbers fail closed.
 */
describe('replica payload-hash property', () => {
  test('object key insertion order never changes canonical JSON', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.stringMatching(/^[a-z]{1,6}$/), fc.integer(), {
          minKeys: 2,
          maxKeys: 6,
        }),
        (obj) => {
          const keys = Object.keys(obj);
          const reversed: Record<string, number> = {};
          for (const k of [...keys].reverse()) reversed[k] = obj[k]!;
          expect(canonicalJson(reversed)).toBe(canonicalJson(obj));
        },
      ),
      { numRuns: 40, seed: 53300 },
    );
  });

  test('intentPayloadHash is pure for equal structured payloads', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-z]{1,12}$/),
        fc.stringMatching(/^[a-z.]{1,24}$/),
        jsonSafe,
        async (appId, action, input) => {
          const a = await intentPayloadHash({ appId, action, input }, nodeDigest);
          const b = await intentPayloadHash(
            { appId, action, input: structuredClone(input) },
            nodeDigest,
          );
          expect(a).toBe(b);
          expect(a).toMatch(/^[a-f0-9]{64}$/);
        },
      ),
      { numRuns: 32, seed: 53301 },
    );
  });

  test('key-reordered nested input yields the same hash', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          title: fc.string({ minLength: 1, maxLength: 16 }),
          nested: fc.record({
            seed: fc.integer(),
            parity: fc.constantFrom('even', 'odd'),
          }),
        }),
        async (input) => {
          const forward = {
            appId: 'notes',
            action: 'create',
            input: {
              title: input.title,
              nested: { seed: input.nested.seed, parity: input.nested.parity },
            },
          };
          const reordered = {
            appId: 'notes',
            action: 'create',
            input: {
              nested: { parity: input.nested.parity, seed: input.nested.seed },
              title: input.title,
            },
          };
          expect(await intentPayloadHash(forward, nodeDigest)).toBe(
            await intentPayloadHash(reordered, nodeDigest),
          );
        },
      ),
      { numRuns: 32, seed: 53302 },
    );
  });

  test('any leaf change produces a different hash', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        async (a, b) => {
          fc.pre(a !== b);
          const h1 = await intentPayloadHash(
            { appId: 'notes', action: 'create', input: { title: a } },
            nodeDigest,
          );
          const h2 = await intentPayloadHash(
            { appId: 'notes', action: 'create', input: { title: b } },
            nodeDigest,
          );
          expect(h1).not.toBe(h2);
        },
      ),
      { numRuns: 24, seed: 53303 },
    );
  });

  test('appId or action change changes the hash even when input is equal', async () => {
    await fc.assert(
      fc.asyncProperty(jsonSafe, async (input) => {
        const base = await intentPayloadHash(
          { appId: 'notes', action: 'create', input },
          nodeDigest,
        );
        const otherApp = await intentPayloadHash(
          { appId: 'tasks', action: 'create', input },
          nodeDigest,
        );
        const otherAction = await intentPayloadHash(
          { appId: 'notes', action: 'update', input },
          nodeDigest,
        );
        expect(base).not.toBe(otherApp);
        expect(base).not.toBe(otherAction);
      }),
      { numRuns: 24, seed: 53304 },
    );
  });

  test('non-finite numbers fail closed', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        (n) => {
          expect(() => canonicalJson(n)).toThrow(/not JSON-safe/);
        },
      ),
      { numRuns: 6, seed: 53305 },
    );
  });

  test('array order is significant', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer(), { minLength: 2, maxLength: 6 }), async (arr) => {
        const rev = [...arr].reverse();
        fc.pre(JSON.stringify(arr) !== JSON.stringify(rev));
        const h1 = await intentPayloadHash(
          { appId: 'notes', action: 'create', input: arr },
          nodeDigest,
        );
        const h2 = await intentPayloadHash(
          { appId: 'notes', action: 'create', input: rev },
          nodeDigest,
        );
        expect(h1).not.toBe(h2);
      }),
      { numRuns: 20, seed: 53306 },
    );
  });
});
