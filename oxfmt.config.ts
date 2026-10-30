import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

// Ultracite supplies the reviewed formatting baseline. Oxfmt is the sole style
// owner and this file is the repository's only formatter configuration.
//
// In addition to the preset's standard generated-output exclusions, the
// entries below are append-only records or generator output whose
// byte-exactness is asserted elsewhere, so reformatting them would rewrite
// history or re-break `format:check` on regeneration.
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
    // Xcode owns asset catalog metadata.
    "**/*.xcassets/**/Contents.json",
    // Receipts and the quality ledger are append-only records; a reformat
    // would rewrite history.
    "receipts/**",
    "QUALITY.md",
    // Generator-owned outputs with regeneration checks elsewhere in the repo.
    // The public site's token sheet is lowered from @centraid/design by
    // scripts/site-tokens.mjs; `lint:site-tokens` asserts it byte-for-byte.
    "scripts/*-site/public/assets/centraid-tokens.css",
    // The native tool task's export (#1088): `nativetools export` writes these
    // files, and `crates/nativetools/tests/export_fixture.rs` asserts them
    // byte for byte against the live export.
    "contracts/assist/export/**",
    // The frozen eval sets of the native tool task (#1044): every file's sha256
    // is recorded in eval/FROZEN.md and `eval/build_sets.py check` compares it,
    // so a reformat is a new set version, not a style fix.
    "experiments/toolchat/native/eval/sets/**",
    "scripts/docs-site/src/content/**",
  ],
});
