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
        // included file (renderer/mobile included). Ratcheted to 30 as the
        // measured total reached ~32% (renderer logic-extraction added the
        // first tranche of desktop unit coverage). Never lowered.
        lines: 30,
        // Per-package floors ratchet toward the 80% line / 70% branch target
        // band (TESTING.md) as coverage grows — set a tight margin below the
        // measured baseline, enough to absorb noise without flaking, never down.
        // Measured at this commit: app-engine 76.7/74.8, automation 69.4/75.2,
        // blueprints 84.7/75.8, gateway 76.4/72.3, agent-runtime 28.6/85.2.
        'packages/app-engine/src/**': { lines: 75, branches: 73 },
        'packages/automation/src/**': { lines: 68, branches: 74 },
        'packages/blueprints/src/**': { lines: 83, branches: 74 },
        'packages/gateway/src/**': { lines: 75, branches: 71 },
        'packages/agent-runtime/src/**': { lines: 27, branches: 84 },
      },
    },
  },
});
