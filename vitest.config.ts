import { defineConfig } from 'vitest/config';
import coverageFloors from './tests/coverage-floors.json';

// Every package that participates in the repo-wide vitest run. `vitest.diff-
// coverage.config.ts` (#576) filters this same list down to the packages a diff
// touches, so the two configs cannot drift into disagreeing about what exists.
export const coverageProjects = [
  'packages/agent-runtime',
  'packages/app-engine',
  'packages/automation',
  'packages/backup',
  'packages/blob-format',
  'packages/blueprints',
  'packages/client',
  'packages/design-tokens',
  'packages/gateway',
  'packages/protocol',
  'packages/cli',
  'packages/tunnel',
  'packages/test-kit',
  'packages/vault',
  'apps/desktop',
  'apps/extension',
  'apps/mobile',
  'apps/oauth-worker',
  'apps/web',
];

// What v8 instruments. Shared with the diff-coverage config so a scoped run
// scores the same file set the full run would.
export const coverageInclude = ['packages/*/src/**', 'apps/*/src/**'];

export const coverageExclude = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.d.ts',
  '**/dist/**',
  '**/index.ts',
  // Test-only harnesses (issue #545 B12) — not product surface.
  'packages/backup/src/testing/**',
  // wasm-bindgen glue for the web iroh transport — generated, not hand-owned.
  'apps/web/src/generated/**',
  // In-tree ACP fake used by agent-runtime tests, not product code.
  'packages/agent-runtime/src/backends/acp/fake-acp-agent.mjs',
];

// Root config: aggregates every package as a Vitest project so `vitest run`
// (and `bun run coverage`) produce ONE v8 coverage report across the whole
// repo — the single coverage tool decision in TESTING.md. Per-package runs go
// through each package's own vitest.config.ts via turbo `test`.
export default defineConfig({
  test: {
    projects: coverageProjects,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: coverageInclude,
      exclude: coverageExclude,
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
