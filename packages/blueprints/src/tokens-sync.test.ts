// Sync gate for the generated blueprint-app token layer. `kit/tokens.css`
// and `kit/wall.css` are generated files (scripts/vendor-tokens.mjs, sourced
// from @centraid/design-tokens' toBlueprintCss() + wall.css) — nothing
// re-runs that script automatically on a design-tokens edit, so without this
// test a change to packages/design-tokens/src/blueprint.ts (or wall.css)
// could land while the checked-in kit/tokens.css / kit/wall.css silently
// drift stale, and CI would stay green. Shelling the script's own `--check`
// mode (rather than re-implementing the diff here) keeps a single source of
// truth for what "in sync" means.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('kit/tokens.css + kit/wall.css sync gate', () => {
  it('bun scripts/vendor-tokens.mjs --check exits 0 (generated files are up to date)', () => {
    const cwd = path.resolve(import.meta.dirname, '..');
    expect(() =>
      execFileSync('bun', ['scripts/vendor-tokens.mjs', '--check'], { cwd, stdio: 'pipe' }),
    ).not.toThrow();
  });
});
