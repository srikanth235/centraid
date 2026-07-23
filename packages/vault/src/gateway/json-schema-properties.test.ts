import { describe, expect, test } from 'vitest';
import { fc } from '@centraid/test-kit/fast-check';
import { validateJson } from './json-schema.js';

/**
 * Vault command JSON-schema properties (#532 core expansion).
 *
 * Model: validateJson is fail-closed for type/required/enum/const/bounds and
 * never invents errors for values that satisfy the declared subset schema.
 */
describe('vault json-schema property', () => {
  test('integer schema accepts every integer and rejects non-integers', () => {
    const schema = { type: 'integer' };
    fc.assert(
      fc.property(fc.integer(), (n) => {
        expect(validateJson(schema, n)).toEqual([]);
      }),
      { numRuns: 32, seed: 53290 },
    );
    fc.assert(
      fc.property(
        fc.oneof(fc.double({ noInteger: true }), fc.string(), fc.boolean(), fc.constant(null)),
        (v) => {
          expect(validateJson(schema, v).length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 32, seed: 53291 },
    );
  });

  test('required + additionalProperties:false fails closed', () => {
    const schema = {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        n: { type: 'integer' },
      },
      additionalProperties: false,
    };
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 16 }), fc.integer(), (id, n) => {
        expect(validateJson(schema, { id, n })).toEqual([]);
        expect(validateJson(schema, { n }).some((e) => e.includes('missing required'))).toBe(true);
        expect(
          validateJson(schema, { id, n, extra: true }).some((e) => e.includes('unexpected')),
        ).toBe(true);
      }),
      { numRuns: 32, seed: 53292 },
    );
  });

  test('enum rejects values outside the set', () => {
    const schema = { enum: ['a', 'b', 'c'] };
    fc.assert(
      fc.property(fc.constantFrom('a', 'b', 'c'), (v) => {
        expect(validateJson(schema, v)).toEqual([]);
      }),
      { numRuns: 16, seed: 53293 },
    );
    fc.assert(
      fc.property(
        fc.string().filter((s) => !['a', 'b', 'c'].includes(s)),
        (v) => {
          expect(validateJson(schema, v).length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 24, seed: 53294 },
    );
  });

  test('const only accepts the exact value', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (c, other) => {
        const schema = { const: c };
        expect(validateJson(schema, c)).toEqual([]);
        fc.pre(JSON.stringify(c) !== JSON.stringify(other));
        expect(validateJson(schema, other).length).toBeGreaterThan(0);
      }),
      { numRuns: 32, seed: 53295 },
    );
  });

  test('minimum/maximum bounds hold for numbers', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: -200, max: 200 }),
        (lo, hi, n) => {
          fc.pre(lo <= hi);
          const schema = { type: 'number', minimum: lo, maximum: hi };
          const errors = validateJson(schema, n);
          if (n >= lo && n <= hi) expect(errors).toEqual([]);
          else expect(errors.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 48, seed: 53296 },
    );
  });

  test('array items schema is checked element-wise', () => {
    const schema = { type: 'array', items: { type: 'integer', minimum: 0 } };
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 100 }), { maxLength: 12 }), (arr) => {
        expect(validateJson(schema, arr)).toEqual([]);
      }),
      { numRuns: 24, seed: 53297 },
    );
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -50, max: 50 }), { minLength: 1, maxLength: 8 }),
        (arr) => {
          fc.pre(arr.some((n) => n < 0));
          expect(validateJson(schema, arr).length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 24, seed: 53298 },
    );
  });

  test('string minLength is enforced', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 8 }), fc.string({ maxLength: 12 }), (minLength, s) => {
        const schema = { type: 'string', minLength };
        const errors = validateJson(schema, s);
        if (s.length >= minLength) expect(errors).toEqual([]);
        else expect(errors.length).toBeGreaterThan(0);
      }),
      { numRuns: 32, seed: 53299 },
    );
  });
});
