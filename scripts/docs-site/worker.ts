/**
 * Cloudflare Worker entry for the Centraid documentation site.
 *
 * The docs site is statically generated into `dist/docs-site/`. Every
 * request is a static file lookup — there is no dynamic content today.
 *
 * This Worker is a deliberate thin passthrough to the `[assets]` binding
 * (see `wrangler.docs.toml`). It exists for two reasons:
 *
 *   1. Symmetry with the sibling clawgnition-web Worker, so ops treats
 *      both deployments identically (same wrangler invocation, same
 *      observability surface, same custom-domain routing model).
 *   2. A landing spot for future edge logic — auth-walled previews,
 *      A/B headers, region-specific redirects — that does *not* require
 *      changing the deployment topology or moving away from
 *      Workers-with-Static-Assets.
 *
 * If/when this stays a thin passthrough forever, we can drop `main`
 * from `wrangler.docs.toml` and serve assets without a Worker at all.
 * The cost of keeping it is one extra request hop with negligible CPU
 * (Cloudflare bills Worker invocations, but static-asset passthroughs
 * are free under the current pricing model).
 */

export interface Env {
  readonly ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Today every path is a static file. The asset binding handles:
    //   - exact matches (`/assets/docs-site.css`, `/og-card.png`)
    //   - directory index resolution (`/concepts/architecture/` -> .../index.html)
    //   - `_headers` / `_redirects` parsed at deploy time
    //   - `not_found_handling: "404-page"` -> serves `/404.html` on misses
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
