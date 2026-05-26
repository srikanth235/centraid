# Centraid docs site

Static-site renderer for `docs.centraid.dev`. Plain-Node ESM build that turns Mintlify-flavored MDX in [`/docs`](../../docs/) into the HTML you see at `dist/docs-site/`.

> Adapted from [openclaw/docs](https://github.com/openclaw/docs) at commit [`277d774`](https://github.com/openclaw/docs/tree/277d7740cba35423143d51a7587e1313e9afe758) (MIT). See [`docs/NOTICE.md`](../../docs/NOTICE.md) for the full attribution.

## Build locally

```sh
bun install
bun run docs:build              # render → search index → pagefind → normalize
bun run docs:smoke              # static checks on dist/docs-site
bun run docs:serve              # http.server on 127.0.0.1:4173
```

Open `http://127.0.0.1:4173/__elements` to review every component variant on a single page (hidden from search and indexing).

## Source layout

```
docs/
├── docs.json           # site config (Mintlify schema): theme, navigation, redirects
├── index.mdx           # landing page
├── *.mdx               # all other pages
├── assets/             # logo, favicon, any image referenced by content
├── _headers            # Cloudflare Pages headers (cache control)
└── NOTICE.md           # third-party attribution
```

Anything in `docs/` that isn't `.md` / `.mdx` / `.json` gets copied verbatim to the deploy root (so `_headers` is picked up automatically).

## Renderer layout

```
scripts/docs-site/
├── build.mjs           # entry — collects pages, renders, writes dist/docs-site/
├── mdx-ish.mjs         # Mintlify-flavored MDX → HTML
├── assets.mjs          # bundled site CSS + JS (the look)
├── config.mjs          # locale + ignore lists
├── elements-fixture.mjs # /__elements component review page
├── og-card-template.mjs # per-page OG image template
├── og-render-worker.mjs # worker thread for resvg PNG rendering
├── source-index.mjs    # writes .md alternates for every HTML page
├── pagefind-normalize.mjs # post-process Pagefind output
├── llms-full.mjs       # generate llms-full.txt corpus (optional)
└── smoke.mjs           # static checks on dist/docs-site
```

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `DOCS_SITE_CANONICAL_ORIGIN` | `https://docs.centraid.dev` | Absolute URL baked into canonical links, sitemap, OG tags. |
| `DOCS_SITE_CNAME` | (unset) | If set and `_ORIGIN` is unset, used as `https://${CNAME}`. Also writes a `CNAME` file. |
| `DOCS_SITE_BASE_PATH` | `""` | Path prefix when serving under a subdirectory (e.g. `/docs`). |
| `DOCS_SITE_LEGACY_BASE_PATH` | `/docs` | Legacy prefix that emits compatibility redirects. |
| `DOCS_SITE_ARTIFACT_MODE` | `full` | `full` builds content, `shell` builds just the chrome. |
| `DOCS_SITE_SHELL_ASSET_VERSION` | (auto sha256) | Override the asset-fingerprint hash. |
| `DOCS_SITE_CHAT_API_URL` | `""` (disabled) | If set, mounts a docs-chat sidebar that POSTs to this URL. |
| `DOCS_SITE_LLMS_FULL_AVAILABLE` | `0` | Set to `1` if you separately publish `/llms-full.txt`. |

## Deploy: Cloudflare Pages

1. **Create the Pages project** in the Cloudflare dashboard, connected to the GitHub repo.
2. **Framework preset**: None.
3. **Build command**: `bun install && bun run docs:build`
4. **Build output directory**: `dist/docs-site`
5. **Root directory**: `/` (the repo root)
6. **Environment variables** (production):
   - `DOCS_SITE_CANONICAL_ORIGIN` = `https://docs.centraid.dev`
   - `NODE_VERSION` = `22` (or `24`)
7. **Custom domain**: add `docs.centraid.dev` under the Pages project's *Custom domains* tab. Cloudflare will provision the certificate.

The build is fully static — no Pages Functions or Worker needed. `_headers` in the output controls cache.

## Smoke locally before pushing

```sh
DOCS_SITE_CANONICAL_ORIGIN=https://docs.centraid.dev bun run docs:build
DOCS_SITE_CANONICAL_ORIGIN=https://docs.centraid.dev bun run docs:smoke
```

## Customizing the look

- **Brand colors / fonts**: top of `assets.mjs` — `:root` and `:root[data-theme="light"]` CSS variables.
- **Logo**: `docs/assets/centraid-mark.svg`. Used by the header brand, og card, and favicon.
- **Header links**: edit the hardcoded `topLink(...)` calls in `build.mjs` (search for `header-links`).
- **OG card design**: `og-card-template.mjs`. Re-run the regenerator (see git history) to refresh the static fallback.
