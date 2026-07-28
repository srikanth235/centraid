// Regenerates src/kit/theme/tokens.generated.ts directly from the canonical
// blueprint token source. Run with: bun run generate:theme
//
// The lowering logic lives (and is unit-tested) in src/kit/theme/generate.ts;
// this wrapper only does file I/O so the parser stays pure and testable.

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { toBlueprintCss } from '@centraid/design-tokens';

import { buildTheme, renderTokensModule } from '../src/kit/theme/generate';

const here = import.meta.dirname;
const repoRoot = path.join(here, '..', '..', '..');
const OUT = path.join(here, '..', 'src', 'kit', 'theme', 'tokens.generated.ts');
const SOURCE = '@centraid/design-tokens#toBlueprintCss';

const theme = buildTheme(toBlueprintCss());
writeFileSync(OUT, renderTokensModule(theme, SOURCE), 'utf8');

console.log(`Wrote ${path.relative(repoRoot, OUT)} from ${SOURCE}`);
