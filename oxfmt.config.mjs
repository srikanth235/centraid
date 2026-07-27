import { defineConfig } from 'oxfmt';
import ultracite from 'ultracite/oxfmt';

// Ultracite's oxfmt preset is the base. Everything after the spread is this
// repo's own long-standing formatting contract, and it deliberately overrides
// the preset:
//
//   printWidth     100 vs the preset's 80
//   singleQuote    true vs false
//   trailingComma  'all' vs 'es5'
//   sortImports    not adopted — it reorders every import block in the repo
//
// Taking the preset's values instead would rewrite all 2745 formatted files,
// which is a whole-repo style decision rather than a dependency bump.
//
// `ignorePatterns` is NOT inherited from the preset. The entries below exist
// because oxfmt must not rewrite them:
//   - `.governance/**` and the kit-managed CI workflow are owned by
//     governance-kit and re-stamped on every `kit update`; reformatting them
//     diverges from upstream and re-breaks CI (this happened once already on
//     the 0.2 -> 0.3 update).
//   - the rest are generator output whose byte-exactness is asserted elsewhere,
//     so reformatting them just re-breaks `format:check` on regeneration.
// `sortImports` and the legacy `experimentalSortPackageJson` spelling are
// dropped from the spread: oxfmt 0.60 rejects the latter as a duplicate of
// `sortPackageJson`, and adopting import sorting would reorder every import
// block in the repo.
const { sortImports: _sortImports, ...base } = ultracite;

export default defineConfig({
  ...base,
  ignorePatterns: [
    '**/dist/**',
    '**/.expo/**',
    '**/node_modules/**',
    '**/*.md',
    '**/*.xcassets/**/Contents.json',
    '.governance/**',
    '.github/workflows/governance.yml',
    'scripts/docs-site/src/content/**',
    'packages/blueprints/manifest.json',
    'packages/blueprints/kit/tokens.css',
    'packages/blueprints/kit/wall.css',
  ],
  arrowParens: 'always',
  bracketSameLine: false,
  bracketSpacing: true,
  endOfLine: 'lf',
  sortPackageJson: true,
  jsxSingleQuote: false,
  printWidth: 100,
  quoteProps: 'as-needed',
  semi: true,
  singleQuote: true,
  tabWidth: 2,
  trailingComma: 'all',
  useTabs: false,
});
