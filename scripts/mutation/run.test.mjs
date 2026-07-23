import { describe, expect, test } from 'vitest';
import { buildScoresArtifact, mutationScoreFromReport, MUTATION_SEEDS } from './run.mjs';

describe('mutationScoreFromReport', () => {
  test('reads top-level mutationScore', () => {
    expect(mutationScoreFromReport({ mutationScore: 82.5 })).toBe(82.5);
  });

  test('reads metrics.mutationScore', () => {
    expect(mutationScoreFromReport({ metrics: { mutationScore: 71 } })).toBe(71);
  });

  test('derives score from killed/totalValid', () => {
    expect(mutationScoreFromReport({ metrics: { killed: 8, totalValid: 10 } })).toBe(80);
  });

  test('returns null for empty report', () => {
    expect(mutationScoreFromReport(null)).toBe(null);
    expect(mutationScoreFromReport({})).toBe(null);
  });
});

describe('MUTATION_SEEDS', () => {
  test('covers the three #532 seed packages with package-local configs', () => {
    expect(MUTATION_SEEDS.map((s) => s.id).sort()).toEqual(
      ['packages/automation', 'packages/client/src/replica', 'packages/vault'].sort(),
    );
    for (const seed of MUTATION_SEEDS) {
      expect(seed.config).toBe('stryker.config.mjs');
      expect(seed.cwd.startsWith('packages/')).toBe(true);
      expect(seed.report.startsWith('artifacts/mutation/')).toBe(true);
    }
  });
});

describe('buildScoresArtifact', () => {
  test('wraps package rows for the test-health report path', () => {
    const artifact = buildScoresArtifact([
      { id: 'packages/vault', label: 'vault', score: 80, status: 'ok' },
    ]);
    expect(artifact.lane).toBe('mutation');
    expect(artifact.packages).toHaveLength(1);
    expect(artifact.generatedAt).toMatch(/^\d{4}-/);
  });
});
