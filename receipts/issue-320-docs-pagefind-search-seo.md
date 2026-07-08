# Issue #320 — docs: Pagefind search and SEO improvements

## Checklist

- [x] Docs build emits a Pagefind index under dist/docs-site/pagefind
- [x] Cmd+K search uses Pagefind and returns section deep links
- [x] Indexed docs pages include canonical, Open Graph, Twitter, JSON-LD and Pagefind metadata
- [x] Docs home includes common task shortcuts
- [x] Understand page includes a glossary/core terms section
- [x] Start/README prerequisites agree on Node >= 24
- [x] docs:build, docs:smoke, check and governance pass

## What changed

**Docs build emits a Pagefind index under dist/docs-site/pagefind.** `package.json`
and `bun.lock` add `pagefind`; `scripts/docs-site/build.mjs` now runs Astro,
normalizes generated section anchors onto headings for Pagefind sub-results, and
then runs the Pagefind CLI into `dist/docs-site/pagefind/`.

**Cmd+K search uses Pagefind and returns section deep links.**
`scripts/docs-site/src/components/SiteHead.astro` points the search button at the
Pagefind bundle, and `scripts/docs-site/public/assets/docs.js` keeps the
existing modal while importing Pagefind, applying metadata weights, rendering
Pagefind excerpts, and following section URLs like `/start/#phone`.

**Indexed docs pages include canonical, Open Graph, Twitter, JSON-LD and
Pagefind metadata.** `scripts/docs-site/src/layouts/DocsLayout.astro` adds
Pagefind body/meta markers, `og:image`, Twitter image metadata, JSON-LD image
data, per-page labels and keywords. `scripts/docs-site/public/assets/og-docs.svg`
is the shared social preview image. `scripts/docs-site/smoke.mjs` now checks the
Pagefind bundle, share image, SEO metadata, Pagefind body marker, and Pagefind
label metadata.

**Docs home includes common task shortcuts.**
`scripts/docs-site/src/content/index.html` adds a Common tasks section linking to
install, first app, import, phone pairing, daemon, and backup anchors.
`scripts/docs-site/public/assets/docs.css` styles the task grid in the existing
paper/manual visual language.

**Understand page includes a glossary/core terms section.**
`scripts/docs-site/src/content/understand.html` adds the glossary definitions,
`scripts/docs-site/src/pages/understand.astro` adds the rail entry and search
keywords, and `scripts/docs-site/public/assets/docs.css` adds the dense glossary
layout.

**Start/README prerequisites agree on Node >= 24.**
`scripts/docs-site/src/content/start.html` now matches `README.md` by requiring
Node >= 24 for `node:sqlite`.

**docs:build, docs:smoke, check and governance pass.** Verification commands are
recorded below. `scripts/docs-site/README.md` also documents the Pagefind build
flow, search-label convention, and expanded smoke coverage.

Per-page search labels and keywords were added in:
`scripts/docs-site/src/pages/index.astro`,
`scripts/docs-site/src/pages/start.astro`,
`scripts/docs-site/src/pages/understand.astro`,
`scripts/docs-site/src/pages/data.astro`,
`scripts/docs-site/src/pages/apps.astro`,
`scripts/docs-site/src/pages/devices.astro`, and
`scripts/docs-site/src/pages/ontology.astro`.

## Out of scope

- Replacing the custom modal with Pagefind's stock UI.
- Per-page generated OG images; this change uses one shared docs preview asset.
- Search filters/facets beyond Pagefind relevance and section sub-results.

## Decisions

- Kept the existing `Cmd+K` modal so the interaction remains native to the docs
  shell while Pagefind owns indexing, ranking and excerpts.
- Normalized generated HTML before Pagefind indexing because authored section
  anchors live on `<section>` elements, while Pagefind sub-results split on
  headings with IDs.

## Verification

```sh
bun run docs:build
bun run docs:smoke
DOCS_SITE_BASE_PATH=/docs DOCS_SITE_CANONICAL_ORIGIN=https://centraid.dev/docs bun run docs:build
DOCS_SITE_BASE_PATH=/docs bun run docs:smoke
bun run docs:build
bun run docs:smoke
bun run check
bash .governance/run.sh
git diff --check
```

The Pagefind API was also exercised against the local docs server for queries
`pair phone`, `ctx.vault`, and `node:sqlite`; results returned section deep links
such as `/start/#phone`, `/apps/#model`, and `/start/#install`.

## Audit

PASS — The diff matches the issue checklist: Pagefind replaces the old JSON
search index, `Cmd+K` still opens the custom modal, generated results include
section anchors, SEO/social metadata is emitted and smoke-tested, the home task
links and Understand glossary are present, and the Node prerequisite now matches
the README.

## Steering

PASS — no human-steering events were found in the issue #320 task transcript, so no `### Steering` rows are required. The only user message in the supplied session excerpt starts a later, separate task (`review the docs and share your suggestinos...` at `2026-07-08T06:07:43Z`), not a mid-task redirection for this receipt. The receipt correctly has no non-steering messages recorded under accounting.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019f404b-8a0-1783492182-1 | codex | 019f404b-8a0e-76d2-81a0-071f1f0e43ed | #320 | gpt-5.5 | 476644 | 0 | 18850816 | 44653 | 521297 | 13.1482 | 476644 | 0 | 18850816 | 44653 | feat(docs): add Pagefind search and SEO metadata (#320) |
| codex-019f404b-8a0-1783492336-1 | codex | 019f404b-8a0e-76d2-81a0-071f1f0e43ed | #320 | gpt-5.5 | 25310 | 0 | 1651840 | 2453 | 27763 | 1.0261 | 501954 | 0 | 20502656 | 47106 | feat(docs): add Pagefind search and SEO metadata (#320) |
