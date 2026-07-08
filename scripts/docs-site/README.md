# Centraid docs site

Static site for `centraid.dev/docs/`. The docs are Astro-built static HTML with
hand-authored body fragments in [`src/content`](src/content/) and shared shell
components in [`src/components`](src/components/) + [`src/layouts`](src/layouts/).
There is no client framework; interactivity stays vanilla JS. Search is
Pagefind-backed: the build runs Astro first, moves generated section anchors
onto headings for section-level results, then indexes the generated HTML into
`dist/docs-site/pagefind/` for the custom `⌘K` modal.

```
scripts/docs-site/
├── src/pages/      # Astro routes: /, /start/, /data/, /apps/, /devices/, /ontology/
├── src/content/    # hand-authored HTML body fragments
├── src/components/ # shared header, footer, section rail
├── src/layouts/    # shared SEO/head/body shell
└── public/         # docs.css + docs.js + shared assets + _headers
```

Every chapter page shares `public/assets/docs.css` / `public/assets/docs.js` (paper/night
theme, left section rail, reveals) and matches the visual language of the
landing page at `scripts/home-site/public/index.html` — same palette, same
fonts (Fraunces / Newsreader / IBM Plex Mono), same hard-shadow artifacts.
The ontology route keeps its bespoke CSS/JS inside `src/content` because it is a
large interactive spec document.

## Build & preview

```sh
bun run docs:build   # Astro build → dist/docs-site
bun run docs:smoke   # required files exist + every internal link resolves
bun run docs:serve   # http.server on 127.0.0.1:4173
```

## Deploy

Cloudflare Worker with static assets binding (see `wrangler.docs.toml`;
`worker.ts` here is the thin passthrough entry):

```sh
bun run docs:deploy:dry   # validate config
bun run docs:deploy       # upload + activate
```

## Authoring conventions

- Chapter pages are long-form body fragments rendered through `DocsLayout`.
  Keep each page's rail array in `src/pages/*.astro` aligned with section `id`s;
  `docs.js` scroll-spies those anchors.
- Public routes are clean directories: `/docs/data/`, `/docs/apps/`, and so on.
  This is v0, so no legacy `.html` aliases are emitted.
- Searchable pages opt in through `DocsLayout`'s `data-pagefind-body` marker.
  Keep `searchLabel` short (`Start`, `Data`, `Apps`, …) so results scan well.
- New shared shell belongs in Astro components/layouts; visual primitives belong
  in `public/assets/docs.css`; browser behavior belongs in `public/assets/docs.js`.
- `docs:smoke` fails on broken internal links, homepage links to the old docs
  subdomain or `.html` filenames, missing SEO/search metadata, and any
  resurrected "Duaility" branding.
