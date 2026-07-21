import { defineConfig } from 'vitest/config';
import coverageFloors from './tests/coverage-floors.json';

// Root config: aggregates every package as a Vitest project so `vitest run`
// (and `bun run coverage`) produce ONE v8 coverage report across the whole
// repo — the single coverage tool decision in TESTING.md. Per-package runs go
// through each package's own vitest.config.ts via turbo `test`.
export default defineConfig({
  test: {
    projects: [
      'packages/agent-runtime',
      'packages/app-engine',
      'packages/automation',
      'packages/backup',
      'packages/blob-format',
      'packages/blueprints',
      'packages/client',
      'packages/design-tokens',
      'packages/gateway',
      'packages/tunnel',
      'packages/test-kit',
      'packages/vault',
      'apps/desktop',
      'apps/mobile',
      'apps/web',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/*.d.ts', '**/dist/**', '**/index.ts'],
      // Engine packages are where the meaningful coverage lives (TESTING.md).
      // These are the *seeded* regression floors — set a conservative margin
      // below the measured baseline so they catch backsliding without flaking,
      // then ratchet upward as coverage grows. Renderer (desktop) and mobile
      // are deliberately ungated here: their meaningful coverage is
      // logic-units + e2e journeys, not a line percentage. Per-glob keys only
      // gate matching files; everything else is tracked, not gated.
      thresholds: coverageFloors,
    },
  },
});
