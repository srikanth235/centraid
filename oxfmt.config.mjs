import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

// #573 adopts Ultracite's formatter preset wholesale. The only local extension
// is the protected/generated ignore list below: those paths have external
// owners or byte-exact generation contracts and must not be restyled.
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
  ignorePatterns: [
    ...base.ignorePatterns,
    "**/dist/**",
    "**/.expo/**",
    "**/node_modules/**",
    "**/*.md",
    "**/*.xcassets/**/Contents.json",
    ".governance/**",
    ".github/workflows/governance.yml",
    "apps/web/public/sw.js",
    "scripts/docs-site/src/content/**",
    "packages/blueprints/manifest.json",
    "packages/blueprints/kit/tokens.css",
    "packages/blueprints/kit/wall.css",
  ],
});
