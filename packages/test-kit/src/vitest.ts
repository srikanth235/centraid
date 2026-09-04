import { fileURLToPath } from "node:url";

import { defineProject, mergeConfig } from "vitest/config";
import type { UserWorkspaceConfig } from "vitest/config";

type ProjectConfig = UserWorkspaceConfig;

// setupFiles paths resolve against the consuming project root, not test-kit.
// `../src/`, not `./`: this module resolves from `dist/vitest.js` in a built
// package and from `src/vitest.ts` in the source tree, and the setup file is a
// TypeScript module vitest loads itself, so it is only ever under `src/`. Both
// paths land on the same file.
const JSDOM_SETUP = fileURLToPath(
  new URL("../src/jsdom-setup.ts", import.meta.url)
);

// Zero-assertion tests fail (#496). A legitimately assertion-free test must
// call `expect.assertions(0)`.
const requireAssertions = {
  expect: {
    requireAssertions: true,
  },
} as const;

// Vite's `client` environment refuses to bundle `node:sqlite`, which jsdom
// projects legitimately reach for. Must be a `pre` plugin: neither
// `resolve.builtins` nor `test.server.deps.external` reaches that resolver.
// Installed on BOTH presets (#842) because environments are per FILE and
// plugins per PROJECT: a node project lacking it silently collects zero tests
// from a `@vitest-environment jsdom` file.
const externalizeNodeSqlite = {
  name: "centraid:external-node-sqlite",
  enforce: "pre" as const,
  resolveId(id: string) {
    return id === "node:sqlite" ? { id, external: true } : null;
  },
};

const nodePreset = {
  plugins: [externalizeNodeSqlite],
  test: {
    environment: "node",
    pool: "forks",
    ...requireAssertions,
    // Node projects are fsync-bound, and hosted-runner disk latency swings ~10x
    // between instances; 30s covers the slowest such test at that penalty. A
    // deadlock still reports, just later. jsdom does no disk I/O and keeps the
    // 5s default. Do NOT add a per-test `}, N)` override BELOW this number: it
    // becomes a cap on exactly the slow I/O tests that need the headroom.
    testTimeout: 30_000,
    // Hooks carry the same bootstrap work as the test they prepare.
    hookTimeout: 30_000,
  },
} satisfies ProjectConfig;

const jsdomPreset = {
  esbuild: { jsx: "automatic" as const },
  plugins: [externalizeNodeSqlite],
  test: {
    environment: "jsdom",
    css: { modules: { classNameStrategy: "non-scoped" as const } },
    ...requireAssertions,
    // React act mode for every jsdom project — see jsdom-setup.ts.
    setupFiles: [JSDOM_SETUP],
  },
} satisfies ProjectConfig;

export function nodeProject(
  config: ProjectConfig
): ReturnType<typeof defineProject> {
  return defineProject(mergeConfig(nodePreset, config));
}

export function jsdomProject(
  config: ProjectConfig
): ReturnType<typeof defineProject> {
  return defineProject(mergeConfig(jsdomPreset, config));
}
