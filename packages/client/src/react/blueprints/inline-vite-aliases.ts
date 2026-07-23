import { fileURLToPath } from 'node:url';

// Resolve-alias entries that rewrite a blueprint app's served sibling imports
// (`./kit.ts` and its `../` forms) to the shell-side adapter when a bundled app
// is consumed INLINE (see kit-inline.ts). Shared verbatim by apps/web/vite.config,
// apps/desktop/vite.config, and packages/client/vitest.config so all three
// build paths rewrite identically.
//
// The `find` patterns are anchored to RELATIVE specifiers (`./` or `../`) on
// purpose: kit-inline.ts re-exports the REAL kit from the bare package subpath
// `@centraid/blueprints/kit/kit.js` (the TypeScript source's package
// specifier). A broad `/kit\.(?:js|ts)$/` would also match that re-export and loop kit.ts back onto
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
      find: /^\.\.?\/(?:.*\/)?kit\.ts$/,
      replacement: here('./kit-inline.ts'),
    },
    {
      // Photos retains a relative browser-module specifier; inline it resolves
      // directly to the client's canonical TypeScript implementation.
      find: /^\.\.?\/(?:.*\/)?video-frame\.js$/,
      replacement: here('../../video-frame.ts'),
    },
  ];
}
