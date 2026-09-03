import { defineConfig } from "vitest/config";

import { mobileVitestProjects } from "./apps/mobile/vitest.projects";
import floors from "./tests/floors.json";

export const coverageProjects = [
  "vitest.quality.config.ts",
  "packages/core",
  "packages/server",
  "packages/backup",
  "packages/blueprints",
  "packages/client",
  "packages/design",
  "packages/cli",
  "packages/tunnel",
  "packages/test-kit",
  "packages/vault",
  "apps/desktop",
  "apps/extension",
  ...mobileVitestProjects,
  "apps/oauth-worker",
  "apps/web",
  "packages/model-runtime",
];

export const coverageInclude = [
  "packages/*/src/**/*.{ts,tsx,js,jsx,mjs,cjs}",
  "apps/*/src/**/*.{ts,tsx,js,jsx,mjs,cjs}",
  "packages/blueprints/apps/**/*.{ts,tsx}",
  "packages/model-runtime/automation-handlers/**/*.js",
  "packages/blueprints/automations/**/handler.js",
  "apps/web/public/sw.js",
];

export const coverageExclude = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.d.ts",
  "**/dist/**",
  "**/index.ts",
  "packages/backup/src/testing/**",
  "apps/web/src/generated/**",
  "packages/server/src/acp/backends/acp/fake-acp-harness.mjs",
  "packages/blueprints/automations/{embed-image,embed-text,faces,photo-ocr,place-names,transcript}/**",
];

export default defineConfig({
  test: {
    projects: coverageProjects,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      reportsDirectory: "./coverage",
      include: coverageInclude,
      exclude: coverageExclude,
      thresholds: floors.coverage,
    },
  },
});
