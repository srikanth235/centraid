import { defineConfig } from 'vitest/config';

import { coverageExclude, coverageInclude, coverageProjects } from './vitest.config';

// Scoped coverage lane for the local diff-coverage gate (#576).
//
// `bun run coverage` runs all 19 projects instrumented — 418s on an M-series
// Mac, uncacheable by turbo (it invokes vitest directly), and paid in full on
// every push. The diff-coverage gate only ever scores *changed* lines, so
// scripts/test-report/diff-coverage-run.mjs narrows this config to the packages
// a diff touches with repeated `--project` flags.
//
// The one substantive difference from the root config is that the seeded
// per-glob coverage floors are OFF here. Those floors are a whole-repo signal:
// in a scoped run every project that did not execute reports 0% and trips its
// floor, which says nothing true about the diff. Floors stay enforced where
// they mean something — `bun run coverage` in the CI `verify` job, and
// `test:ratchet`, which is what stops them drifting downward.
//
// This is a *separate file* rather than an env-var branch inside the root
// config on purpose: a flag that silently disables coverage floors is one
// stray export away from disabling them in CI. A config nobody's CI invokes
// cannot do that.
export default defineConfig({
  test: {
    projects: coverageProjects,
    coverage: {
      provider: 'v8',
      // No text/html here: this lane's only consumer is diff-coverage.mjs
      // reading coverage-final.json, and the text table for a scoped run
      // reports 0% for every project that did not run, which reads as alarming
      // and means nothing.
      reporter: ['json'],
      reportsDirectory: './coverage',
      include: coverageInclude,
      exclude: coverageExclude,
    },
  },
});
