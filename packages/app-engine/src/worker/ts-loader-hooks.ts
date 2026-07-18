/*
 * Module-customization hooks that teach a handler worker to import TypeScript
 * (TS-authored apps ship `.ts` queries/actions).
 *
 * Production runs the COMPILED dist under plain Node (>=22.5) — no tsx, no TS
 * loader — so `await import()` of a `.ts` handler graph would otherwise fail
 * to parse. The worker registers these hooks (via `module.register`, see
 * worker/runner.ts) ONLY when the handler it's about to run is a `.ts`/`.tsx`
 * file, so a `.js` dispatch never installs them and its native import path is
 * untouched.
 *
 * `load` compiles `.ts`/`.tsx` sources to ESM with `esbuild.transform` (loader
 * picked by extension) and short-circuits; every other URL falls through to
 * the default loader. `resolve` fills the two gaps Node's ESM resolver leaves
 * for a TS graph: an extensionless sibling import (`./util`) and the TS
 * convention of importing a sibling by its emitted `.js` name while the source
 * on disk is `.ts` (`./util.js` → `./util.ts`). A plain existing `.js` import
 * resolves natively and never reaches the fallback.
 *
 * This file is a `.ts` source compiled to `dist/worker/ts-loader-hooks.js`;
 * the registration URL in runner.ts resolves the `.js` under dist and the
 * `.ts` under tsx (tests), so both boot shapes find it.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

interface ResolveContext {
  parentURL?: string;
  conditions: readonly string[];
  importAttributes: Record<string, string>;
}
interface ResolveResult {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
}
type NextResolve = (
  specifier: string,
  context: ResolveContext,
) => ResolveResult | Promise<ResolveResult>;

interface LoadContext {
  format?: string | null;
  conditions: readonly string[];
  importAttributes: Record<string, string>;
}
interface LoadResult {
  format: string;
  source?: string | ArrayBuffer | Uint8Array;
  shortCircuit?: boolean;
}
type NextLoad = (url: string, context: LoadContext) => LoadResult | Promise<LoadResult>;

const TS_URL_RE = /\.tsx?$/;

/** Candidate on-disk TS URLs for a relative specifier Node couldn't resolve. */
function tsCandidates(specifier: string, parentURL: string): string[] {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return [];
  const bases: string[] = [];
  if (specifier.endsWith('.js')) {
    // TS ESM convention: source imports the emitted `.js`, file on disk is `.ts`.
    bases.push(specifier.slice(0, -3));
  } else if (path.extname(specifier) === '') {
    bases.push(specifier);
  }
  const urls: string[] = [];
  for (const base of bases) {
    for (const ext of ['.ts', '.tsx']) {
      const candidate = new URL(base + ext, parentURL);
      if (existsSync(fileURLToPath(candidate))) urls.push(candidate.href);
    }
  }
  return urls;
}

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<ResolveResult> {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (context.parentURL) {
      const [first] = tsCandidates(specifier, context.parentURL);
      if (first) return { url: first, format: 'module', shortCircuit: true };
    }
    throw err;
  }
}

export async function load(
  url: string,
  context: LoadContext,
  nextLoad: NextLoad,
): Promise<LoadResult> {
  if (!TS_URL_RE.test(url)) return nextLoad(url, context);
  const file = fileURLToPath(url);
  const source = await readFile(file, 'utf8');
  const { code } = await esbuild.transform(source, {
    loader: url.endsWith('.tsx') ? 'tsx' : 'ts',
    format: 'esm',
    sourcefile: file,
    // TS-authored handlers may use React dialect in a `.tsx` sibling; keep the
    // same automatic runtime as the browser transform. Inert for plain `.ts`.
    jsx: 'automatic',
  });
  return { format: 'module', source: code, shortCircuit: true };
}
