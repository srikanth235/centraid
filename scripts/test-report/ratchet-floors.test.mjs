import { describe, expect, test } from 'vitest';
import {
  diffCoverageFloors,
  diffMinimumTests,
  diffMutationFloors,
  diffPerfBudgetNumbers,
  extractBudgetNumbersFromSource,
  flattenBudgetNumbers,
  isBudgetFloorKey,
  ratchetFloors,
} from './ratchet-floors.mjs';

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

describe('diffMutationFloors', () => {
  test('flags a package mutation score decrease', () => {
    expect(
      diffMutationFloors(
        { 'packages/vault': 80, 'packages/automation': 70 },
        { 'packages/vault': 75, 'packages/automation': 70 },
      ),
    ).toEqual(['mutation floor "packages/vault" decreased 80 → 75']);
  });

  test('flags removal of a mutation floor', () => {
    expect(diffMutationFloors({ 'packages/vault': 80 }, {})).toEqual([
      'mutation floor "packages/vault" removed (was 80)',
    ]);
  });

  test('allows increase and equal', () => {
    expect(diffMutationFloors({ 'packages/vault': 80 }, { 'packages/vault': 85 })).toEqual([]);
    expect(diffMutationFloors({ 'packages/vault': 80 }, { 'packages/vault': 80 })).toEqual([]);
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

describe('perf budget ratchet', () => {
  test('isBudgetFloorKey recognizes min* keys', () => {
    expect(isBudgetFloorKey('minStreamsForProof')).toBe(true);
    expect(isBudgetFloorKey('maxRequests')).toBe(false);
    expect(isBudgetFloorKey('requestP99Ms')).toBe(false);
  });

  test('flattenBudgetNumbers walks nested trees', () => {
    expect(
      flattenBudgetNumbers({
        shell: { maxRequests: 10, nested: { maxTransferBytes: 100 } },
        minStreamsForProof: 3,
      }),
    ).toEqual({
      'shell.maxRequests': 10,
      'shell.nested.maxTransferBytes': 100,
      minStreamsForProof: 3,
    });
  });

  test('diffPerfBudgetNumbers flags ceiling widen and min loosen', () => {
    expect(
      diffPerfBudgetNumbers(
        { 'shell.maxRequests': 10, minStreamsForProof: 3 },
        { 'shell.maxRequests': 12, minStreamsForProof: 3 },
      ),
    ).toEqual(['perf budget "shell.maxRequests" widened 10 → 12 (ceilings may only tighten)']);

    expect(diffPerfBudgetNumbers({ minStreamsForProof: 3 }, { minStreamsForProof: 2 })).toEqual([
      'perf budget "minStreamsForProof" loosened 3 → 2 (min floors may only rise)',
    ]);
  });

  test('diffPerfBudgetNumbers allows tighten and equal', () => {
    expect(
      diffPerfBudgetNumbers(
        { 'shell.maxRequests': 10, minStreamsForProof: 3 },
        { 'shell.maxRequests': 8, minStreamsForProof: 4 },
      ),
    ).toEqual([]);
    expect(diffPerfBudgetNumbers({ a: 1 }, { a: 1 })).toEqual([]);
  });

  test('extractBudgetNumbersFromSource parses nested TS export', () => {
    const source = `
export interface PerfBudgets { shell: { maxRequests: number } }
export const perfBudgets: PerfBudgets = {
  shell: {
    // comment
    maxRequests: 10,
    maxTransferBytes: 1_250_000,
  },
  irohPool: {
    minStreamsForProof: 3,
  },
};
export const enforceTiming = true;
`;
    expect(extractBudgetNumbersFromSource(source, 'perfBudgets')).toEqual({
      'shell.maxRequests': 10,
      'shell.maxTransferBytes': 1_250_000,
      'irohPool.minStreamsForProof': 3,
    });
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

  test('waives mutation floor decrease with mutation approvedDeviation', () => {
    const { errors, waived } = ratchetFloors({
      baseFloors: { lines: 30 },
      headFloors: { lines: 30 },
      baseMatrix: { flows: [] },
      headMatrix: { flows: [] },
      baseMutation: { 'packages/vault': 80 },
      headMutation: {
        'packages/vault': 70,
        approvedDeviation: 'temporary #532 recalibration after suite split',
      },
    });
    expect(waived).toBe(true);
    expect(errors).toEqual([]);
  });

  test('fails mutation floor decrease without waiver', () => {
    const { errors } = ratchetFloors({
      baseFloors: { lines: 30 },
      headFloors: { lines: 30 },
      baseMatrix: { flows: [] },
      headMatrix: { flows: [] },
      baseMutation: { 'packages/vault': 80 },
      headMutation: { 'packages/vault': 70 },
    });
    expect(errors.some((e) => e.includes('mutation floor'))).toBe(true);
  });

  test('fails perf budget widen without approvedDeviation', () => {
    const { errors } = ratchetFloors({
      baseFloors: { lines: 30 },
      headFloors: { lines: 30 },
      baseMatrix: { flows: [] },
      headMatrix: { flows: [] },
      perfBudgets: [
        {
          label: 'apps/web/tests/e2e/perf-budgets.ts',
          base: { 'shell.maxRequests': 10 },
          head: { 'shell.maxRequests': 99 },
        },
      ],
    });
    expect(errors.some((e) => e.includes('widened'))).toBe(true);
  });

  test('allows perf budget widen with approvedDeviation', () => {
    const { errors } = ratchetFloors({
      baseFloors: { lines: 30 },
      headFloors: { lines: 30 },
      baseMatrix: { flows: [] },
      headMatrix: { flows: [] },
      perfBudgets: [
        {
          label: 'apps/web/tests/e2e/perf-budgets.ts',
          base: { 'shell.maxRequests': 10 },
          head: { 'shell.maxRequests': 99 },
          approvedDeviation: 'measured regression after intentional fixture growth (#999)',
        },
      ],
    });
    expect(errors).toEqual([]);
  });
});
