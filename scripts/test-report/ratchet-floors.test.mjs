import { describe, expect, test } from 'vitest';
import { diffCoverageFloors, diffMinimumTests, ratchetFloors } from './ratchet-floors.mjs';

describe('diffCoverageFloors', () => {
  test('flags a top-level line floor decrease', () => {
    expect(diffCoverageFloors({ lines: 30 }, { lines: 25 })).toEqual([
      'coverage floor "lines" decreased 30 → 25',
    ]);
  });

  test('flags a package metric decrease', () => {
    const base = { 'packages/vault/src/**': { lines: 90, branches: 78 } };
    const head = { 'packages/vault/src/**': { lines: 88, branches: 78 } };
    expect(diffCoverageFloors(base, head)).toEqual([
      'coverage floor "packages/vault/src/**.lines" decreased 90 → 88',
    ]);
  });

  test('flags removal of a package scope', () => {
    const base = { 'packages/vault/src/**': { lines: 90 } };
    const head = { lines: 30 };
    expect(diffCoverageFloors(base, head)).toEqual([
      'coverage floor scope "packages/vault/src/**" removed',
    ]);
  });

  test('flags removal of a single metric key', () => {
    const base = { 'packages/vault/src/**': { lines: 90, branches: 78 } };
    const head = { 'packages/vault/src/**': { lines: 90 } };
    expect(diffCoverageFloors(base, head)).toEqual([
      'coverage floor "packages/vault/src/**.branches" removed (was 78)',
    ]);
  });

  test('flags removal of a top-level number floor', () => {
    expect(diffCoverageFloors({ lines: 30, branches: 20 }, { lines: 30 })).toEqual([
      'coverage floor "branches" removed (was 20)',
    ]);
  });

  test('allows increases and equal floors', () => {
    expect(diffCoverageFloors({ lines: 30 }, { lines: 31 })).toEqual([]);
    expect(diffCoverageFloors({ lines: 30 }, { lines: 30 })).toEqual([]);
  });
});

describe('diffMinimumTests', () => {
  test('flags a minimumTests decrease without waiver', () => {
    const base = { flows: [{ id: 'a', minimumTests: 10 }] };
    const head = { flows: [{ id: 'a', minimumTests: 8 }] };
    expect(diffMinimumTests(base, head)).toHaveLength(1);
  });

  test('flags removal of minimumTests key', () => {
    const base = { flows: [{ id: 'a', minimumTests: 10 }] };
    const head = { flows: [{ id: 'a' }] };
    expect(diffMinimumTests(base, head).join('')).toMatch(/minimumTests removed/);
  });

  test('flags deletion of a flow that had minimumTests', () => {
    const base = { flows: [{ id: 'a', minimumTests: 10 }] };
    const head = { flows: [] };
    expect(diffMinimumTests(base, head).join('')).toMatch(/flow "a" removed/);
  });

  test('allows decrease with approvedMinimumTestsDeviation', () => {
    const base = { flows: [{ id: 'a', minimumTests: 10 }] };
    const head = {
      flows: [
        { id: 'a', minimumTests: 8, approvedMinimumTestsDeviation: 'issue #999 consolidation' },
      ],
    };
    expect(diffMinimumTests(base, head)).toEqual([]);
  });

  test('allows increase', () => {
    const base = { flows: [{ id: 'a', minimumTests: 10 }] };
    const head = { flows: [{ id: 'a', minimumTests: 12 }] };
    expect(diffMinimumTests(base, head)).toEqual([]);
  });
});

describe('ratchetFloors', () => {
  test('waives floor decreases when approvedDeviation is set', () => {
    const { errors, waived } = ratchetFloors({
      baseFloors: { lines: 30 },
      headFloors: { lines: 20, approvedDeviation: 'constitutional exception for #1' },
      baseMatrix: { flows: [] },
      headMatrix: { flows: [] },
    });
    expect(waived).toBe(true);
    expect(errors).toEqual([]);
  });

  test('fails floor decrease without waiver', () => {
    const { errors } = ratchetFloors({
      baseFloors: { lines: 30 },
      headFloors: { lines: 20 },
      baseMatrix: { flows: [] },
      headMatrix: { flows: [] },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  test('deletion of a floor scope is not waived without approvedDeviation', () => {
    const { errors } = ratchetFloors({
      baseFloors: { 'packages/vault/src/**': { lines: 90 } },
      headFloors: {},
      baseMatrix: { flows: [] },
      headMatrix: { flows: [] },
    });
    expect(errors.some((e) => e.includes('removed'))).toBe(true);
  });
});
