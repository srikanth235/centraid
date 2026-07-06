# Centraid docs site

Static site for `docs.centraid.dev`. The docs are **hand-authored HTML/CSS** in
[`/docs`](../../docs/) — there is no renderer, no MDX, no build-time framework.
The site is deliberately small and long-form:

```
docs/
├── index.html      # front door — two personas, three pillars
├── start.html      # path 1: install → vault → first app → phone → always-on
├── data.html       # pillar: vault, consent, outbox, sealed, connections, automations, assistant, blobs, search
├── apps.html       # pillar: blueprints, anatomy, builder, attach/link, agent surface, mobile
├── devices.html    # pillar: topology, addressing, pairing, iroh, desktop, mobile, runtimes
├── ontology.html   # the full logical model — self-contained interactive page
├── 404.html
├── assets/         # docs.css + docs.js (shared shell) + centraid-mark.svg
├── _headers        # cache control served by Cloudflare
└── plans/          # repo-internal notes — excluded from the deploy
```

Every chapter page shares `assets/docs.css` / `assets/docs.js` (paper/night
theme, left section rail, reveals) and matches the visual language of the
landing page at `scripts/home-site/public/index.html` — same palette, same
fonts (Fraunces / Newsreader / IBM Plex Mono), same hard-shadow artifacts.
`ontology.html` carries its own embedded CSS (it predates the shared shell and
has bespoke interactive components) but uses the same tokens.

## Build & preview

```sh
bun run docs:build   # copy docs/ → dist/docs-site (excludes *.md, plans/)
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

- Chapter pages are long-form with a fixed left rail (`<nav class="rail">`);
  keep rail hrefs in sync with section `id`s — `docs.js` scroll-spies them.
- Link between pages with plain relative `*.html` hrefs (works locally and on
  Cloudflare).
- New shared components belong in `docs.css`; page-specific one-offs can stay
  inline.
- `docs:smoke` fails on broken internal links, dead `/docs/...` MDX-era URLs,
  and any resurrected "Duaility" branding — run it before pushing.
