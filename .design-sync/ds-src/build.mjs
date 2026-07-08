// Build the Centraid blueprint-kit design-system bundle for design-sync.
//
// Deterministic, self-contained: regenerate the token CSS from the repo's
// built @centraid/design-tokens, copy the canonical kit.css verbatim, then
// tsc-compile the React wrappers to dist/ (js + .d.ts). Re-run on every sync
// so the tokens/kit CSS never drift from the product.
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const stylesDir = resolve(here, 'styles');
mkdirSync(stylesDir, { recursive: true });

// 1. Token CSS — the full :root + per-theme + per-density var blocks.
const { toCss } = await import(
  resolve(repoRoot, 'packages/design-tokens/dist/index.js')
);
writeFileSync(resolve(stylesDir, 'tokens.css'), toCss());
console.log('[build] wrote styles/tokens.css');

// 2. The canonical kit stylesheet — copied verbatim, never edited here.
copyFileSync(
  resolve(repoRoot, 'packages/blueprints/kit/kit.css'),
  resolve(stylesDir, 'kit.css'),
);
console.log('[build] copied styles/kit.css');

// 3. The flat cssEntry the converter copies into _ds_bundle.css. Concatenated
// (not @import'd) because the converter copies cssEntry verbatim and does not
// resolve @import closures. Order: tokens define the vars → fonts register
// @font-face → bridge maps token vars onto the kit's app-level contract →
// kit.css (reads those vars) last. Font url()s stay `../fonts/*.woff2`
// relative to styles/, which is where this file lives, so extractFonts copies
// them. Rendered designs receive this whole file via styles.css's closure.
const parts = ['tokens.css', 'fonts.css', 'bridge.css', 'kit.css'].map(
  (f) => `/* ==== ${f} ==== */\n${readFileSync(resolve(stylesDir, f), 'utf8')}`,
);
writeFileSync(resolve(stylesDir, 'bundle.css'), parts.join('\n\n'));
console.log('[build] wrote styles/bundle.css (cssEntry)');

// 4. Compile the wrappers.
execSync('npx tsc -p tsconfig.json', { cwd: here, stdio: 'inherit' });
console.log('[build] tsc done -> dist/');
