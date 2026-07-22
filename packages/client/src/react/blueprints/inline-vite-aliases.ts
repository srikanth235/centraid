import { fileURLToPath } from 'node:url';

// Resolve-alias entries that rewrite a blueprint app's ambient sibling imports
// (`./react-core.min.js`, `./kit.js`, and their `../` forms) to the shell-side
// shims when a bundled app is consumed INLINE (see
// react-core-shim.ts / kit-inline.ts). Shared verbatim by apps/web/vite.config,
// apps/desktop/vite.config, and packages/client/vitest.config so all three
// build paths rewrite identically.
//
// The `find` patterns are anchored to RELATIVE specifiers (`./` or `../`) on
// purpose: kit-inline.ts re-exports the REAL kit from the bare package subpath
// `@centraid/blueprints/kit/kit.js`. A broad `/kit\.js$/` (as the issue sketch
// suggested) would also match that re-export and loop kit.js back onto
// kit-inline — so we match only the app-relative form the blueprint sources use
// and leave the package-subpath specifier untouched.
export interface InlineAliasEntry {
  find: RegExp;
  replacement: string;
}

export function inlineBlueprintAliases(): InlineAliasEntry[] {
  const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
  return [
    {
      find: /^\.\.?\/(?:.*\/)?react-core\.min\.js$/,
      replacement: here('./react-core-shim.ts'),
    },
    {
      find: /^\.\.?\/(?:.*\/)?kit\.js$/,
      replacement: here('./kit-inline.ts'),
    },
  ];
}
