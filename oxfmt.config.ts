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
    // The nightly report's sheet (#853) is the same lowering from the same
    // emitter, gated the same way — one file rather than a per-surface
    // `assets/` copy, because the report is published at two depths and
    // inlines its faces. See docs/design-divergences.md#the-nightly-test-report.
    "scripts/test-report/report-tokens.css",
    "scripts/docs-site/src/content/**",
    "packages/blueprints/manifest.json",
    // The peer-target differential corpus (#842 W2.1) is emitted by
    // `serializeCorpus` and read UNCHANGED by a Rust test, so its bytes are the
    // interface between the two languages. `peer-target-differential.test.ts`
    // asserts them exactly; letting oxfmt restyle the braces makes that
    // assertion fail on every regeneration while proving nothing about style.
    "packages/tunnel/fixtures/peer-target-corpus.json",
  ],
});
