// Build the Centraid desktop-shell design-system bundle for design-sync.
//
// Single-source, no drift: the real renderer components live at
// apps/desktop/src/renderer/react/ui/. Every build copies them here fresh,
// regenerates the token CSS from the repo's built @centraid/design-tokens,
// copies the renderer's canonical styles.css verbatim, and concatenates the
// flat cssEntry. The importable entry is esbuild-bundled (design-tokens
// inlined from source, react/react-dom external — the converter provides
// React via _vendor/), and tsc emits the .d.ts tree for prop extraction.
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, copyFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const uiDir = resolve(repoRoot, 'apps/desktop/src/renderer/react/ui');
const srcDir = resolve(here, 'src');
const stylesDir = resolve(here, 'styles');
const distDir = resolve(here, 'dist');
mkdirSync(srcDir, { recursive: true });
mkdirSync(stylesDir, { recursive: true });

// 1. Copy the real components fresh (no hand-maintained twins → no drift).
//    Gallery is a demo composite, not a library primitive — excluded from the
//    DS entry (it can be authored as a preview instead).
const COMPONENT_FILES = [
  'Icon.tsx',
  'Button.tsx',
  'Logo.tsx',
  'AppCard.tsx',
  'cx.ts',
  'tile-visual.ts',
];
for (const f of COMPONENT_FILES) copyFileSync(resolve(uiDir, f), resolve(srcDir, f));
console.log('[build] copied', COMPONENT_FILES.length, 'component files from apps/desktop');

// 2. Curated barrel — the four shell primitives + their public types.
writeFileSync(
  resolve(srcDir, 'index.ts'),
  `// Curated design-sync entry — the desktop shell's presentational primitives.
export { default as Icon } from './Icon.js';
export type { IconProps } from './Icon.js';
export { default as Button } from './Button.js';
export type { ButtonProps, ButtonVariant } from './Button.js';
export { default as Logo } from './Logo.js';
export type { LogoProps } from './Logo.js';
export { default as AppCard } from './AppCard.js';
export type { AppCardProps, AppCardTone } from './AppCard.js';
`,
);

// 3. Token CSS — the full :root + per-theme + per-density var blocks that
//    the renderer injects at boot via theme-vars.ts. styles.css reads these.
const { toCss } = await import(resolve(repoRoot, 'packages/design-tokens/dist/index.js'));
writeFileSync(resolve(stylesDir, 'tokens.css'), toCss());
console.log('[build] wrote styles/tokens.css');

// 4. Self-hosted brand fonts — same families the renderer loads from Google
//    Fonts (Geist / Space Grotesk / JetBrains Mono). Reuse the blueprint-kit
//    sync's committed woff2 + @font-face rules (latin subset, OFL). Both the
//    css and the woff2 targets (referenced as ../fonts/*.woff2 from styles/)
//    are copied fresh so this input is reproducible on a clean clone.
const dsFontsDir = resolve(repoRoot, '.design-sync/ds-src/fonts');
const fontsOut = resolve(here, 'fonts');
mkdirSync(fontsOut, { recursive: true });
for (const f of readdirSync(dsFontsDir).filter((n) => n.endsWith('.woff2'))) {
  copyFileSync(resolve(dsFontsDir, f), resolve(fontsOut, f));
}
copyFileSync(
  resolve(repoRoot, '.design-sync/ds-src/styles/fonts.css'),
  resolve(stylesDir, 'fonts.css'),
);
console.log('[build] copied fonts/*.woff2 + styles/fonts.css');

// 5. The canonical renderer stylesheet — copied verbatim, never edited here.
//    It defines the type scale + every cd-* component rule the shell draws.
copyFileSync(
  resolve(repoRoot, 'apps/desktop/src/renderer/styles.css'),
  resolve(stylesDir, 'styles.css'),
);
console.log('[build] copied styles/styles.css');

// 6. The flat cssEntry the converter copies into _ds_bundle.css. Concatenated
//    (not @import'd — the converter copies cssEntry verbatim). Order: tokens
//    define the vars → fonts register @font-face → styles.css reads both.
//    No bridge needed: styles.css is written directly against design-tokens.
const parts = ['tokens.css', 'fonts.css', 'styles.css'].map(
  (f) => `/* ==== ${f} ==== */\n${readFileSync(resolve(stylesDir, f), 'utf8')}`,
);
writeFileSync(resolve(stylesDir, 'bundle.css'), parts.join('\n\n'));
console.log('[build] wrote styles/bundle.css (cssEntry)');

// 7. Importable entry — esbuild bundles the components with design-tokens
//    inlined from TS source (its dist is CJS; source keeps named exports
//    clean), react/react-dom external so the converter binds them to _vendor.
rmSync(distDir, { recursive: true, force: true });
const esbuild = await import(
  pathToFileURL(resolve(repoRoot, '.ds-sync/node_modules/esbuild/lib/main.js')).href
);
await esbuild.build({
  entryPoints: [resolve(srcDir, 'index.ts')],
  bundle: true,
  format: 'esm',
  jsx: 'automatic',
  target: 'es2020',
  outfile: resolve(distDir, 'index.js'),
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  alias: { '@centraid/design-tokens': resolve(repoRoot, 'packages/design-tokens/src/index.ts') },
  logLevel: 'info',
});
console.log('[build] esbuild -> dist/index.js');

// 8. .d.ts tree for prop extraction (ts-morph reads these).
execSync('npx tsc -p tsconfig.json', { cwd: here, stdio: 'inherit' });
console.log('[build] tsc -> dist/*.d.ts');
