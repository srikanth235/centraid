import { defineConfig } from 'vitest/config';

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
      'packages/blueprints',
      'packages/gateway',
      'packages/openclaw-plugin',
      'packages/skills',
      'apps/desktop',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        '**/dist/**',
        '**/index.ts',
        'packages/design-tokens/**',
      ],
      // Engine packages are where the meaningful coverage lives (TESTING.md).
      // These are the *seeded* regression floors — set a conservative margin
      // below the measured baseline so they catch backsliding without flaking,
      // then ratchet upward as coverage grows. Renderer (desktop) and mobile
      // are deliberately ungated here: their meaningful coverage is
      // logic-units + e2e journeys, not a line percentage. Per-glob keys only
      // gate matching files; everything else is tracked, not gated.
      thresholds: {
        // Repo-wide line floor: a global anti-regression guard across every
        // included file (renderer/mobile included), seeded below the measured
        // ~31% total so it catches a broad backslide without flaking. Ratchet
        // up as renderer logic-extraction and e2e land.
        lines: 28,
        'packages/app-engine/src/**': { lines: 72, branches: 70 },
        'packages/automation/src/**': { lines: 65, branches: 71 },
        'packages/blueprints/src/**': { lines: 80, branches: 71 },
        'packages/gateway/src/**': { lines: 72, branches: 68 },
        'packages/agent-runtime/src/**': { lines: 18, branches: 78 },
      },
    },
  },
});
