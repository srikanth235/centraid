import { fileURLToPath } from 'node:url';
import { defineProject, mergeConfig, type UserWorkspaceConfig } from 'vitest/config';

type ProjectConfig = UserWorkspaceConfig;

// Resolved from this file rather than named as a bare specifier: consuming
// projects run with their own cwd, and setupFiles paths are resolved against
// the project root, not against test-kit.
const JSDOM_SETUP = fileURLToPath(new URL('jsdom-setup.ts', import.meta.url));

// #496 E5 — fail any test that runs zero assertions. Cheap partial defense
// against assertion-gutting (matrix minimumTests counts `test(`/`it(` call
// sites, not expect calls). Legitimately assertion-free tests must call
// `expect.assertions(0)` or be rewritten to assert an outcome.
const requireAssertions = {
  expect: {
    requireAssertions: true,
  },
} as const;

const nodePreset = {
  test: {
    environment: 'node',
    pool: 'forks',
    ...requireAssertions,
    // Node projects are the node:sqlite ones: they bootstrap real vault/daemon
    // layouts on disk, so their wall clock is fsync-bound, not CPU-bound.
    // Hosted-runner storage latency varies enough between runner instances to
    // blow the 5s default even though nothing about the code changed. Measured
    // on one day, same `bun run coverage` command, same ubuntu-24.04 image,
    // same node 22.23.1 — ci run 29733633559 (passed) vs nightly 29733737906
    // (failed), per test FILE:
    //   serve/vault-plane      10.7s -> 71.5s  (6.7x)
    //   serve/vault-registry   11.2s -> 65.0s  (5.8x)
    //   stores/gateway-db       2.1s -> 18.7s  (8.8x)
    //   routes/import-routes    1.1s -> 10.9s  (9.8x)
    // The median file across the whole run was 0.83x — CPU-bound tests were
    // unaffected, so this is disk latency on the slow host, NOT v8 coverage
    // instrumentation (coverage is on in BOTH lanes) and NOT a regression: all
    // 16 nightly failures were timeouts, zero assertion failures.
    // Budget: the slowest test still on this default measured ~2.9s on a fast
    // host; at the ~10x worst observed host penalty that is ~29s, so 30s. Kept
    // well below a real-hang signal — a deadlock never completes at any budget,
    // it just takes 30s instead of 5s to report. jsdom projects deliberately
    // keep Vitest's tight 5s default: they do no disk I/O.
    //
    // Do NOT add a per-test `}, N)` override below this number. Eight tests
    // carried 10s/15s/20s overrides written against the old 5s default, where
    // they were RAISES; raising the default silently turned them into CAPS on
    // exactly the slow I/O-bound tests that needed the headroom most, and
    // stream-ingress.test.ts then timed out at its own 15s in ci run
    // 29755774783 while everything around it had 30s. They are gone. A test
    // genuinely slower than 30s should say so with an override ABOVE it.
    testTimeout: 30_000,
  },
} satisfies ProjectConfig;

const jsdomPreset = {
  esbuild: { jsx: 'automatic' as const },
  test: {
    environment: 'jsdom',
    css: { modules: { classNameStrategy: 'non-scoped' as const } },
    ...requireAssertions,
    // Puts React into act mode for every jsdom project — see jsdom-setup.ts.
    setupFiles: [JSDOM_SETUP],
  },
} satisfies ProjectConfig;

/** Shared node:sqlite-safe Vitest project preset. */
export function nodeProject(config: ProjectConfig): ReturnType<typeof defineProject> {
  return defineProject(mergeConfig(nodePreset, config));
}

/** Shared browser-logic preset: jsdom + automatic JSX + readable CSS modules. */
export function jsdomProject(config: ProjectConfig): ReturnType<typeof defineProject> {
  return defineProject(mergeConfig(jsdomPreset, config));
}
