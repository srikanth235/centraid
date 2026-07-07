# Issue 315 - Docs routing and Astro docs site

## Checklist

- [x] Home page docs links no longer reference `docs.centraid.dev`.
- [x] Docs build emits static clean routes for `/`, `/start/`, `/data/`, `/apps/`, `/devices/`, and `/ontology/`.
- [x] Smoke checks verify internal docs links and reject old `.html` home-page docs links.
- [x] Shared docs structure removes the flat-page HTML/CSS duplication introduced by the v0 docs.

## What changed

- Home page docs links no longer reference `docs.centraid.dev`. `scripts/home-site/public/index.html` now links to `/docs/`, `/docs/start/`, `/docs/data/`, `/docs/apps/`, `/docs/devices/`, and `/docs/ontology/`.
- Docs build emits static clean routes for `/`, `/start/`, `/data/`, `/apps/`, `/devices/`, and `/ontology/`. `astro.config.mjs`, `package.json`, `bun.lock`, `scripts/docs-site/build.mjs`, and `.github/workflows/docs.yml` move the docs build to Astro with `DOCS_SITE_BASE_PATH` and `DOCS_SITE_CANONICAL_ORIGIN` support.
- Smoke checks verify internal docs links and reject old `.html` home-page docs links. `scripts/docs-site/smoke.mjs` now walks directory-route output, resolves links under an optional `/docs` base path, checks required assets, rejects `docs.centraid.dev`, and rejects old `/docs/<route>.html` links from the home page.
- Shared docs structure removes the flat-page HTML/CSS duplication introduced by the v0 docs. The old flat files `docs/404.html`, `docs/_headers`, `docs/apps.html`, `docs/data.html`, `docs/devices.html`, `docs/index.html`, `docs/ontology.html`, `docs/start.html`, `docs/assets/centraid-mark.svg`, `docs/assets/docs.css`, and `docs/assets/docs.js` were replaced with `scripts/docs-site/public/_headers`, `scripts/docs-site/public/assets/centraid-mark.svg`, `scripts/docs-site/public/assets/docs.css`, `scripts/docs-site/public/assets/docs.js`, `scripts/docs-site/src/layouts/DocsLayout.astro`, `scripts/docs-site/src/components/SectionRail.astro`, `scripts/docs-site/src/components/SiteFooter.astro`, `scripts/docs-site/src/components/SiteHead.astro`, `scripts/docs-site/src/pages/404.astro`, `scripts/docs-site/src/pages/apps.astro`, `scripts/docs-site/src/pages/data.astro`, `scripts/docs-site/src/pages/devices.astro`, `scripts/docs-site/src/pages/index.astro`, `scripts/docs-site/src/pages/ontology.astro`, `scripts/docs-site/src/pages/start.astro`, `scripts/docs-site/src/content/404.html`, `scripts/docs-site/src/content/apps.html`, `scripts/docs-site/src/content/data.html`, `scripts/docs-site/src/content/devices.html`, `scripts/docs-site/src/content/index.html`, `scripts/docs-site/src/content/ontology-body.html`, `scripts/docs-site/src/content/ontology-style.css`, and `scripts/docs-site/src/content/start.html`.
- Supporting docs and tool configuration were updated in `README.md`, `ARCHITECTURE.md`, `scripts/docs-site/README.md`, `scripts/docs-site/worker.ts`, `.gitignore`, and `.oxfmtrc.jsonc` so the repo points at `https://centraid.dev/docs/`, documents clean routes, ignores Astro cache output, and keeps raw docs HTML fragments out of `oxfmt`.

## Out of scope

- Legacy `.html` compatibility aliases are intentionally not emitted. This is v0 docs content, and issue #315 tracks the clean `/docs/<route>/` production shape.
- Moving the legacy `docs.centraid.dev` Cloudflare route itself is out of scope; this change removes active source/home-page links and canonical docs config that pointed at the old subdomain.

## Decisions

- Chose Astro for the docs site so the existing hand-authored HTML can keep static output and SEO-friendly markup while sharing layout, metadata, footer, rail, assets, and build-time base path handling.
- Kept ontology as raw imported HTML/CSS inside an Astro page because it has bespoke interactive behavior that should survive the migration without a visual rewrite.
- Removed `.html` aliases after product clarification that v0 does not need legacy URL compatibility.

## Verification

```sh
bun run docs:build
```

```sh
bun run docs:smoke
```

```sh
DOCS_SITE_BASE_PATH=/docs DOCS_SITE_CANONICAL_ORIGIN=https://centraid.dev/docs bun run docs:build
```

```sh
DOCS_SITE_BASE_PATH=/docs bun run docs:smoke
```

```sh
bun run format:check
```

```sh
bunx oxlint astro.config.mjs scripts/docs-site/build.mjs scripts/docs-site/smoke.mjs
```

## Audit

PASS - The receipt maps the issue #315 checklist to the diff, names each changed file path, records the v0 no-legacy decision, and lists the verification commands used for the docs routing migration.

## Steering

PASS - Reviewed the active Codex transcript for issue #315. The steering ledger records the user interrupt, the correction to pull latest main first, the redirects from a narrow docs-link fix into docs organization/framework migration, the SEO/interactivity clarification, and the v0 no-legacy correction. Ordinary task starts, context injections, and the final create-PR request are not recorded as steering rows.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019f3b6e-c55-1783410795-1 | codex | 019f3b6e-c55b-7cb1-9429-f74bd8a0b318 | #315 | gpt-5.5 | 420293 | 0 | 9773952 | 52375 | 472668 | 8.5597 | 420293 | 0 | 9773952 | 52375 | docs(site): migrate docs to Astro clean routes (#315) -m Move the docs site to A |
| codex-019f3b6e-c55-1783411029-1 | codex | 019f3b6e-c55b-7cb1-9429-f74bd8a0b318 | #315 | gpt-5.5 | 86603 | 0 | 828288 | 7875 | 94478 | 1.0834 | 506896 | 0 | 10602240 | 60250 | docs(site): migrate docs to Astro clean routes (#315) -m Move the docs site to A |
| codex-019f3beb-1a2-1783418056-1 | codex | 019f3beb-1a29-73c3-bf5d-a00cb2011b94 | #315 | gpt-5.5 | 584105 | 0 | 7691776 | 27335 | 611440 | 7.5865 | 584105 | 0 | 7691776 | 27335 | fix(docs): align site shell follow-ups (#315) |
| codex-019f3beb-1a2-1783418111-1 | codex | 019f3beb-1a29-73c3-bf5d-a00cb2011b94 | #315 | gpt-5.5 | 10816 | 0 | 379136 | 552 | 11368 | 0.2602 | 594921 | 0 | 8070912 | 27887 | fix(docs): align site shell follow-ups (#315) -m Keep the docs landing, chapter  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-019f3b6e-1783410919-1 | 019f3b6e-c55b-7cb1-9429-f74bd8a0b318 | #315 | interrupt | structural |  | docs(site): migrate docs to Astro clean routes (#315) | 4 | 2026-07-07T07:17:31.807Z |
| steer-019f3b6e-1783410919-2 | 019f3b6e-c55b-7cb1-9429-f74bd8a0b318 | #315 | correction | classifier | Pull latest main before continuing | docs(site): migrate docs to Astro clean routes (#315) | 5 | 2026-07-07T07:17:39.830Z |
| steer-019f3b6e-1783410919-3 | 019f3b6e-c55b-7cb1-9429-f74bd8a0b318 | #315 | correction | classifier | Reconsider bulk HTML route organization | docs(site): migrate docs to Astro clean routes (#315) | 7 | 2026-07-07T07:22:34.692Z |
| steer-019f3b6e-1783410919-4 | 019f3b6e-c55b-7cb1-9429-f74bd8a0b318 | #315 | correction | classifier | Evaluate whether a framework fits docs pages | docs(site): migrate docs to Astro clean routes (#315) | 8 | 2026-07-07T07:26:18.087Z |
| steer-019f3b6e-1783410919-5 | 019f3b6e-c55b-7cb1-9429-f74bd8a0b318 | #315 | correction | classifier | Address HTML and CSS duplication | docs(site): migrate docs to Astro clean routes (#315) | 9 | 2026-07-07T07:27:34.618Z |
| steer-019f3b6e-1783410919-6 | 019f3b6e-c55b-7cb1-9429-f74bd8a0b318 | #315 | correction | classifier | Check Astro SEO and interactivity impact | docs(site): migrate docs to Astro clean routes (#315) | 10 | 2026-07-07T07:29:18.224Z |
| steer-019f3b6e-1783410919-7 | 019f3b6e-c55b-7cb1-9429-f74bd8a0b318 | #315 | correction | classifier | Proceed with docs migration | docs(site): migrate docs to Astro clean routes (#315) | 11 | 2026-07-07T07:29:48.733Z |
| steer-019f3b6e-1783410919-8 | 019f3b6e-c55b-7cb1-9429-f74bd8a0b318 | #315 | correction | classifier | Skip legacy html compatibility for v0 | docs(site): migrate docs to Astro clean routes (#315) | 12 | 2026-07-07T07:46:21.946Z |
