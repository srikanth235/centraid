import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

// Ultracite supplies the reviewed formatting baseline. Oxfmt is the sole style
// owner and this file is the repository's only formatter configuration.
//
// In addition to the preset's standard generated-output exclusions, these
// entries exist because oxfmt must not rewrite them:
//   - `.governance/**` and the kit-managed CI workflow are owned by
//     governance-kit and re-stamped on every `kit update`; reformatting them
//     diverges from upstream and re-breaks CI (this happened once already on
//     the 0.2 -> 0.3 update).
//   - the rest are generator output whose byte-exactness is asserted elsewhere,
//     so reformatting them just re-breaks `format:check` on regeneration.
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
    // Import evaluation order can be observable. Formatting never reorders
    // side-effect imports.
    sortSideEffects: false,
  },
  sortPackageJson: {
    sortScripts: true,
  },
  ignorePatterns: [
    // Ultracite's baseline contains dependencies/VCS state, build output,
    // generated code, coverage, mobile build trees, lockfiles, and generated
    // framework declarations. Those files have external or generator owners.
    ...base.ignorePatterns,
    // The Iroh generator deliberately finalizes these committed bindings with
    // Oxfmt before rebuild-and-diff CI. Re-include the directory and its three
    // textual outputs after Ultracite's broad `**/generated` exclusion.
    "!apps/web/src/generated/",
    "!apps/web/src/generated/centraid_web_iroh.js",
    "!apps/web/src/generated/centraid_web_iroh.d.ts",
    "!apps/web/src/generated/centraid_web_iroh_bg.wasm.d.ts",
    // Xcode owns asset catalog metadata.
    "**/*.xcassets/**/Contents.json",
    // governance-kit owns this vendored tree and workflow byte-for-byte.
    ".governance/**",
    ".github/workflows/governance.yml",
    // Governance freezes historical receipts/ledgers byte-for-byte and freezes
    // historical sections in the constitution and quality ledger.
    "receipts/**",
    "COSTS.md",
    "STEERING.md",
    "CONSTITUTION.md",
    "QUALITY.md",
    // Generator-owned outputs with regeneration checks elsewhere in the repo.
    "apps/web/public/sw.js",
    // The public site's token sheet is lowered from @centraid/design by
    // scripts/site-tokens.mjs; `lint:site-tokens` asserts it byte-for-byte.
    "scripts/*-site/public/assets/centraid-tokens.css",
    "scripts/docs-site/src/content/**",
    "packages/blueprints/manifest.json",
  ],
});
