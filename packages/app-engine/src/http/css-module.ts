/*
 * CSS-module compiler shared by both serving seams (TypeScript-app support).
 *
 * A blueprint app written in TypeScript may `import styles from
 * './X.module.css'` and reference `styles.foo` for the `.foo` class. The
 * browser resolves that `import` over HTTP as a JavaScript module, so a
 * `*.module.css` file cannot be served as CSS — it must be compiled into an ES
 * module that (a) injects the file's compiled CSS into the document via a
 * `<style>` element and (b) `export default`s the local→hashed class-name map.
 *
 * The SAME compilation is needed in two places, so it lives here once:
 *   - the per-file server (static-server.ts) serves a `*.module.css` request
 *     as this JS body directly;
 *   - the whole-graph bundler (app-bundle.ts) runs it in an `onLoad` handler,
 *     so a `.module.css` file enters esbuild's graph already as JS and the
 *     single-output-file invariant (`result.outputFiles[0]`) still holds — a
 *     raw `default` CSS import would otherwise emit a second CSS output that
 *     the bundler silently drops.
 *
 * esbuild's `transform` returns compiled CSS but no export map, so it can't be
 * used here. Instead we run a tiny `esbuild.build` over a synthetic stdin
 * entry (`import m from "<file>"; export default m;`) with the `local-css`
 * loader, which yields TWO outputs: a JS module holding the class-name map and
 * a separate CSS file with the compiled, locally-scoped rules. We compose the
 * final served module from both. `absWorkingDir` is pinned to the app root so
 * the generated hashed names are deterministic and never leak the gateway's
 * absolute worktree layout (same concern handled in app-bundle.ts buildBundle).
 */

import path from 'node:path';
import * as esbuild from 'esbuild';
import { computeEtag } from './asset-variants.js';

export interface CompiledCssModule {
  /** The style-injecting, map-exporting ES module body. */
  js: string;
  /** The locally-scoped compiled CSS (embedded in `js`); exposed for tests. */
  css: string;
  /** Content etag of `js` (quoted sha256, same convention as computeEtag). */
  etag: string;
}

/**
 * Compile one `*.module.css` file into the served ES module described above.
 *
 * `appRoot` pins `absWorkingDir` so hashed class names are stable across
 * gateways and carry no absolute-path prefix. A distinct `moduleKey` (the
 * file's app-relative path) keys the idempotency guard baked into the emitted
 * `<style>` so the same module injected twice (bundle warm-up + a stray
 * per-file request, HMR re-eval) only ever adds one style element.
 */
export async function compileCssModule(
  filePath: string,
  appRoot: string,
): Promise<CompiledCssModule> {
  // Build over a synthetic stdin entry so we get BOTH the JS class-map module
  // and the compiled CSS as separate outputs. `bundle: true` pulls the
  // `local-css` loader's map into the JS module's default export.
  const result = await esbuild.build({
    stdin: {
      contents: `import m from ${JSON.stringify(filePath)};\nexport default m;`,
      resolveDir: appRoot,
      loader: 'js',
      sourcefile: 'centraid-css-module-entry.js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    // Scope the local-css loader to `.module.css` only — a plain `.css`
    // import (were one to appear) keeps esbuild's default CSS behavior.
    loader: { '.module.css': 'local-css' },
    absWorkingDir: appRoot,
    // A CSS-importing JS entry needs an output path so esbuild can name the
    // emitted CSS file. Virtual only — `write: false` keeps it off disk; we
    // read both outputs from `outputFiles` below.
    outdir: '.centraid-cssmod',
    logLevel: 'silent',
  });

  let js = '';
  let css = '';
  for (const out of result.outputFiles ?? []) {
    if (out.path.endsWith('.css')) css = out.text;
    else js = out.text;
  }

  // The app-relative module key keys the injection guard so a module injected
  // more than once (bundle + a per-file request) adds exactly one <style>.
  const moduleKey = path.relative(appRoot, filePath).split(path.sep).join('/');
  const body = composeModule(js, css, moduleKey);
  return { js: body, css, etag: computeEtag(Buffer.from(body, 'utf8')) };
}

/**
 * Compose the served module: the class-map JS (esbuild's default export of the
 * local→hashed map) with an idempotent `<style>` injector prepended. The
 * injector runs once per document per module key — guarded on a data attribute
 * so a re-eval (HMR, a bundle that also imports the module) never double-adds.
 * `esbuildJs` ends in `export default <map>;`; we keep it verbatim so the
 * default export stays the class map.
 */
function composeModule(esbuildJs: string, css: string, moduleKey: string): string {
  const guard = `data-centraid-css-module`;
  return (
    `// Compiled from ${moduleKey} — CSS module served as JS (see css-module.ts).\n` +
    `(() => {\n` +
    `  if (typeof document === 'undefined') return;\n` +
    `  const key = ${JSON.stringify(moduleKey)};\n` +
    `  if (document.querySelector('style[${guard}=' + JSON.stringify(key) + ']')) return;\n` +
    `  const el = document.createElement('style');\n` +
    `  el.setAttribute(${JSON.stringify(guard)}, key);\n` +
    `  el.textContent = ${JSON.stringify(css)};\n` +
    `  document.head.appendChild(el);\n` +
    `})();\n` +
    esbuildJs
  );
}
