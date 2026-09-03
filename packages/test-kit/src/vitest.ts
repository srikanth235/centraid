import { fileURLToPath } from "node:url";

import { defineProject, mergeConfig } from "vitest/config";
import type { UserWorkspaceConfig } from "vitest/config";

type ProjectConfig = UserWorkspaceConfig;

const JSDOM_SETUP = fileURLToPath(new URL("jsdom-setup.ts", import.meta.url));

const requireAssertions = {
  expect: {
    requireAssertions: true,
  },
} as const;

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
    testTimeout: 30_000,
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
