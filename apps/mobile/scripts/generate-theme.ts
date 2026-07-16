// Regenerates src/theme/tokens.generated.ts from the blueprint kit's
// tokens.css. Run with: bun run generate:theme
//
// The lowering logic lives (and is unit-tested) in src/theme/generate.ts;
// this wrapper only does file I/O so the parser stays pure and testable.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTheme, renderTokensModule } from '../src/theme/generate';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const SOURCE = join(repoRoot, 'packages', 'blueprints', 'kit', 'tokens.css');
const OUT = join(here, '..', 'src', 'theme', 'tokens.generated.ts');

const css = readFileSync(SOURCE, 'utf8');
const theme = buildTheme(css);
const sourcePath = relative(repoRoot, SOURCE);
writeFileSync(OUT, renderTokensModule(theme, sourcePath), 'utf8');

console.log(`Wrote ${relative(repoRoot, OUT)} from ${sourcePath}`);
