import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

const base = ultracite;

export default defineConfig({
  ...base,
  sortImports: {
    groups: [
      "builtin",
      "external",
      ["internal", "subpath"],
      ["parent", "sibling", "index"],
      "style",
      "unknown",
    ],
    ignoreCase: true,
    internalPattern: ["@centraid/", "~/", "@/", "#"],
    newlinesBetween: true,
    order: "asc",
    sortSideEffects: false,
  },
  sortPackageJson: {
    sortScripts: true,
  },
  ignorePatterns: [
    ...base.ignorePatterns,
    "!apps/web/src/generated/",
    "!apps/web/src/generated/centraid_web_iroh.js",
    "!apps/web/src/generated/centraid_web_iroh.d.ts",
    "!apps/web/src/generated/centraid_web_iroh_bg.wasm.d.ts",
    "**/*.xcassets/**/Contents.json",
    // governance-kit owns this vendored tree and workflow byte-for-byte.
    ".governance/**",
    ".github/workflows/governance.yml",
    "receipts/**",
    "COSTS.md",
    "STEERING.md",
    "CONSTITUTION.md",
    "QUALITY.md",
    "apps/web/public/sw.js",
    "scripts/*-site/public/assets/centraid-tokens.css",
    "scripts/test-report/report-tokens.css",
    "scripts/docs-site/src/content/**",
    "packages/blueprints/manifest.json",
    "packages/tunnel/fixtures/peer-target-corpus.json",
  ],
});
