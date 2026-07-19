import { defineProject, mergeConfig, type UserWorkspaceConfig } from 'vitest/config';

type ProjectConfig = UserWorkspaceConfig;

const nodePreset = {
  test: {
    environment: 'node',
    pool: 'forks',
  },
} satisfies ProjectConfig;

const jsdomPreset = {
  esbuild: { jsx: 'automatic' as const },
  test: {
    environment: 'jsdom',
    css: { modules: { classNameStrategy: 'non-scoped' as const } },
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
