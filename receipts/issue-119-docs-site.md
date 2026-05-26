# issue-119 — Static documentation site at docs.centraid.dev

GitHub issue: [#119](https://github.com/srikanth235/centraid/issues/119)

## Checklist

- [x] Source under `docs/` as MDX + JSON IA config
- [x] Custom static-site renderer ported from openclaw/docs (MIT) and rebranded
- [x] 7 top-level tabs: Get started · Concepts · Build apps · Automations · Templates · Deploy · Reference
- [x] Mermaid + svg-pan-zoom for architecture diagrams
- [x] Pagefind for search, per-page OG cards, llms.txt + sitemap
- [x] Deployed via Cloudflare Workers with Static Assets (`wrangler.docs.toml`)
- [x] CI builds + smokes on PRs; deploys on push to main
- [x] `bun run docs:build` produces 37 pages, Pagefind indexes 36
- [x] `bun run docs:smoke` green
- [x] `bun run docs:deploy:dry` green (asset binding recognized; types generation emits `interface Env { ASSETS: Fetcher }`)

## What changed

**Source under `docs/` as MDX + JSON IA config.** A new `docs/` tree carries 35 MDX pages plus `docs.json` (the Mintlify-compatible IA config), `docs/_headers` for Cloudflare cache rules, and `docs/NOTICE.md` for the upstream-port attribution. Pages are organized into seven top-level tabs (see below).

**Custom static-site renderer ported from openclaw/docs (MIT) and rebranded.** `scripts/docs-site/` is a self-contained MDX-to-HTML pipeline adapted under MIT from openclaw/docs@277d7740, with the `oc-` CSS prefix renamed to `cd-` (word-boundary perl substitution) and brand tokens swapped to Centraid indigo `#5B6CFF` on slate dark `#0b0d12`. Pipeline: markdown-it + gray-matter + highlight.js for content, mermaid for diagrams, @resvg/resvg-js for per-page OG cards, Pagefind for client-side search.

**7 top-level tabs: Get started · Concepts · Build apps · Automations · Templates · Deploy · Reference.** Defined in `docs/docs.json`. The Automations tab is a full reference (overview, manifest, triggers, handler runtime, webhooks, run history, conversational builder) reflecting the rich DSL: `triggers[]` array with cron + provisioned-webhook + pending-webhook forms, `ctx.tool`/`agent`/`state`/`runs`/`invoke`, `onFailure` chaining, `history.keep` policies, the headless app-owned model. Queries and actions are framed as *tools* across the site — each `app.json` entry IS a tool definition; the `.js` file IS its implementation.

**Mermaid + svg-pan-zoom for architecture diagrams.** Wide architecture diagrams (the `concepts/architecture` "big picture" is 2483×725 in SVG units, ~4.6× the column width) needed zoom controls. After confirming mermaid itself ships no zoom UI and the mermaid live editor uses `svg-pan-zoom@3.6.2`, the renderer was wired to call `svgPanZoom(svg, { controlIconsEnabled: false, fit: true, center: true, minZoom: 0.2, maxZoom: 12 })` and ship a custom toolbar (3×3 directional pan grid + zoom in/out cluster + fullscreen toggle, styled to match Centraid's button aesthetic). Cmd/Ctrl+wheel zooms at the cursor; Esc exits fullscreen.

**Pagefind for search, per-page OG cards, llms.txt + sitemap.** Pagefind runs against the built `dist/docs-site/` and produces a search index that the in-page modal queries. Per-page OG cards render via a `@resvg/resvg-js` worker thread, one per slug. `llms.txt`, `.well-known/llms.txt`, `robots.txt`, and `sitemap.xml` are emitted in full-artifact mode.

**Deployed via Cloudflare Workers with Static Assets (`wrangler.docs.toml`).** A root `wrangler.docs.toml` mirrors the sibling clawgnition-web config: `[assets]` binding to `./dist/docs-site`, worker entry at `scripts/docs-site/worker.ts` (a thin passthrough to `env.ASSETS.fetch()` that gives a future hook for edge logic without rewiring routes), custom domain `docs.centraid.dev`, observability + invocation logs on. Deviation from the reference: `not_found_handling = "404-page"` because docs is a multi-page static site, not an SPA.

**CI builds + smokes on PRs; deploys on push to main.** `.github/workflows/docs.yml` runs `docs:build` and `docs:smoke` on every PR touching `docs/`, `scripts/docs-site/`, `wrangler.docs.toml`, or `package.json`. On push to `main`, a `deploy` job downloads the built artifact and runs `bun run docs:deploy` via the project-pinned wrangler. Required secrets in the `docs-production` environment: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## Out of scope

- i18n beyond English. The renderer supports the Mintlify multi-language config shape (and openclaw uses it heavily), but only `en` is populated for v0.
- Versioned docs. Single-version site at v0; future major versions can mount under `/v1/`, etc.
- API playground / interactive examples. Static prose + code blocks only.
- A custom-styled 404 page. `not_found_handling = "404-page"` is set; if `/404.html` is absent CF returns a bare 404 status. A polished 404 is a follow-up.
- Versioning the deployment with preview environments per branch. CI only deploys off `main`.
- Resolving the ~46 `TODO(#120)` inline callouts. Tracked separately in issue #120.

## Verification

- `bun run docs:build` produces 37 pages, Pagefind indexes 36 (2711 words) in `dist/docs-site` (full artifact mode).
- `bun run docs:smoke` green: required-file assertions pass, content fuzz checks (poison patterns, canonical-URL pinning, asset version coherence) clean.
- `bun run docs:deploy:dry` green (asset binding recognized; types generation emits `interface Env { ASSETS: Fetcher }`): `wrangler deploy --config wrangler.docs.toml --dry-run` builds the worker (0.20 KiB compiled passthrough) and `wrangler types --config wrangler.docs.toml` generates the Env interface.
- Mermaid pan/zoom buttons verified end-to-end via DOM eval on the architecture page: clicking zoom-in updates `viewport.transform.baseVal.matrix.a` from 0.200 → 0.260 → 0.338 (svg-pan-zoom's default `zoomScaleSensitivity: 0.3` = ×1.3 per click); pan-right click updates `matrix.e` translate value; reset click returns to fit-to-frame.
- `bun run docs:smoke` covers the deploy-side asset list including `assets/svg-pan-zoom.min.js`.
