/**
 * Node ESM resolve hook: map a `./foo.js` specifier onto `./foo.ts` when only
 * the TypeScript file exists (#839 G10).
 *
 * Why this exists: five of the six fuzz targets are reachable from a built
 * `packages/<name>/dist/*.js` — the same way `scripts/design-gallery.mjs` reads
 * `packages/design/dist/font-faces.js`. `packages/client` is the exception: it
 * is a private, bundler-consumed package whose `tsconfig.build.json` is
 * `emitDeclarationOnly`, so there is no `dist/replica/search.js` to import and
 * there never will be. Node strips types from the `.ts` source natively, but it
 * does not rewrite TypeScript's `.js`-extension import convention, so the
 * source's own `./errors.js` import fails to resolve. This hook closes exactly
 * that gap and nothing else — an unrelated missing module still throws.
 *
 * Registered by `scripts/fuzz/targets.mjs` only under plain Node; Vitest's
 * resolver already handles the `.js` → `.ts` convention, so the replay suite
 * never installs it.
 */

/**
 * @param {string} specifier Requested module specifier.
 * @param {object} context Node resolve context.
 * @param {(specifier: string, context: object) => Promise<object>} nextResolve Default resolver.
 * @returns {Promise<object>} Resolution result.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    // Typed translation, not a swallow: a relative `.js` specifier that does
    // not exist is retried once as `.ts`; anything else rethrows untouched.
    const notFound =
      /** @type {NodeJS.ErrnoException} */ (error).code ===
      "ERR_MODULE_NOT_FOUND";
    if (!notFound || !specifier.startsWith(".") || !specifier.endsWith(".js"))
      throw error;
    return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
  }
}
