import { describe, expect, test } from 'vitest';
import {
  buildScoresArtifact,
  enforceMutationFloors,
  mutationScoreFromReport,
  MUTATION_GLOBAL_WATCH,
  MUTATION_SEEDS,
  selectAffectedSeeds,
} from './run.mjs';

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

  test('derives score from Stryker 9 per-file mutants statuses', () => {
    expect(
      mutationScoreFromReport({
        files: {
          'a.ts': {
            mutants: [
              { status: 'Killed' },
              { status: 'Killed' },
              { status: 'Survived' },
              { status: 'Ignored' },
              { status: 'NoCoverage' },
            ],
          },
        },
      }),
    ).toBe(50); // 2 killed / (2 killed + 1 survived + 1 noCoverage)
  });
});

describe('MUTATION_SEEDS', () => {
  test('covers core property-defended packages with package-local configs', () => {
    expect(MUTATION_SEEDS.map((s) => s.id).sort()).toEqual(
      [
        'packages/app-engine',
        'packages/automation',
        'packages/backup',
        'packages/blob-format',
        'packages/client/src/replica',
        'packages/protocol',
        'packages/tunnel',
        'packages/vault',
      ].sort(),
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

describe('selectAffectedSeeds', () => {
  test('returns only seeds whose watch paths appear in the diff', () => {
    const hit = selectAffectedSeeds(['packages/protocol/src/handshake.ts']);
    expect(hit.map((s) => s.label)).toEqual(['protocol']);
  });

  test('global watch forces every seed', () => {
    expect(MUTATION_GLOBAL_WATCH).toContain('tests/mutation-floors.json');
    const hit = selectAffectedSeeds(['tests/mutation-floors.json']);
    expect(hit).toHaveLength(MUTATION_SEEDS.length);
  });

  test('unrelated paths select nothing', () => {
    expect(selectAffectedSeeds(['README.md', 'apps/web/src/main.tsx'])).toEqual([]);
  });
});

describe('enforceMutationFloors', () => {
  test('fails when measured score is below floor', () => {
    expect(
      enforceMutationFloors(
        {
          packages: [{ id: 'packages/vault', score: 90 }],
        },
        { 'packages/vault': 97 },
      ),
    ).toEqual(['mutation floor "packages/vault" not met: measured 90.00 < floor 97']);
  });

  test('passes when score meets floor and skips missing scores', () => {
    expect(
      enforceMutationFloors(
        {
          packages: [
            { id: 'packages/vault', score: 97 },
            { id: 'packages/backup', score: null },
          ],
        },
        { 'packages/vault': 97, 'packages/backup': 42 },
      ),
    ).toEqual([]);
  });
});
