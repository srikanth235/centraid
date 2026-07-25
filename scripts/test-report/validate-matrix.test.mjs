import { describe, expect, test } from 'vitest';
import { validateMatrix } from './validate-matrix.mjs';

function baseMatrix(overrides = {}) {
  return {
    version: 1,
    legend: { solid: 's', partial: 'p', gap: 'g', skip: 'k' },
    notes: {
      'vault.skipdim': 'deliberate skip note',
    },
    dimensions: [
      { id: 'correctness', label: 'Correctness', lane: 'unit' },
      { id: 'skipdim', label: 'Skip dim', lane: 'unit' },
    ],
    surfaces: [
      {
        id: 'vault',
        label: 'Vault',
        assessment: { correctness: 'solid', skipdim: 'skip' },
      },
    ],
    cellOwners: {
      'vault.correctness': { owner: 'packages/vault/package.json', tier: 'unit' },
      'vault.skipdim': null,
    },
    flows: [
      {
        id: 'vault-core-flow',
        name: 'Vault core',
        surface: 'vault',
        dimension: 'correctness',
        tier: 'unit',
        owner: 'packages/vault/package.json',
        minimumTests: 0,
      },
    ],
    ...overrides,
  };
}

describe('validateMatrix', () => {
  test('accepts a minimal well-formed matrix', async () => {
    const { errors } = await validateMatrix(baseMatrix(), { checkEnvGates: false });
    expect(errors).toEqual([]);
  });

  test('rejects missing cell-owner mapping', async () => {
    const matrix = baseMatrix();
    delete matrix.cellOwners['vault.correctness'];
    const { errors } = await validateMatrix(matrix, { checkFiles: false, checkEnvGates: false });
    expect(errors.some((e) => e.includes('no explicit cell-owner'))).toBe(true);
  });

  test('rejects skip cells without notes', async () => {
    const matrix = baseMatrix({ notes: {} });
    const { errors } = await validateMatrix(matrix, { checkFiles: false, checkEnvGates: false });
    expect(errors.some((e) => e.includes('vault.skipdim') && e.includes('no matrix.notes'))).toBe(
      true,
    );
  });

  test('rejects unknown surface on a flow', async () => {
    const matrix = baseMatrix();
    matrix.flows[0].surface = 'not-a-surface';
    const { errors } = await validateMatrix(matrix, { checkFiles: false, checkEnvGates: false });
    expect(errors.some((e) => e.includes('unknown surface'))).toBe(true);
  });

  test('rejects invalid assessment status', async () => {
    const matrix = baseMatrix();
    matrix.surfaces[0].assessment.correctness = 'maybe';
    const { errors } = await validateMatrix(matrix, { checkFiles: false, checkEnvGates: false });
    expect(errors.some((e) => e.includes('invalid or missing assessment'))).toBe(true);
  });

  test('warns (does not fail) when minimumTests is omitted unless required', async () => {
    const matrix = baseMatrix();
    delete matrix.flows[0].minimumTests;
    const { errors, warnings = [] } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
      warnMissingMinimumTests: true,
    });
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('minimumTests'))).toBe(true);
  });
});
