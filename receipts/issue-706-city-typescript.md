# Issue #706 — migrate Centraid City to TypeScript and publish it on centraid.dev

GitHub PR: [#706](https://github.com/srikanth235/centraid/pull/706)

## Checklist

- [x] Migrate the PR-scoped city JavaScript sources to TypeScript.
- [x] Load Three.js from the `@centraid/city` package instead of vendored runtime files.
- [x] Clear the GitHub bot's accessibility, correctness, and code-quality findings.
- [x] Publish the city bundle at `/city/` and link it from the centraid.dev homepage navigation.

## What changed

The private `@centraid/city` package remains the source of the visualization. Its standalone `build` stays rooted at `/`, while the new `build:site` mode sets Vite's asset base to `/city/` so the same package can be served from the public site without checked-in generated files. `package.json` owns the Three.js dependency; no vendor copy was restored.

The root `docs:bundle` command installs the package-local lockfile, builds the site variant, and assembles it under `dist/site/city`. The home page now exposes a highlighted `city` navigation tab, and the docs smoke test verifies both the tab and the `/city/assets/` output path. The docs CI change filter includes `centraid-city/**` so future city-only changes run the site lane.

Checklist evidence:

- Migrate the PR-scoped city JavaScript sources to TypeScript. — `centraid-city/src/**/*.ts` is the typed source tree and the package typecheck passes.
- Load Three.js from the `@centraid/city` package instead of vendored runtime files. — `centraid-city/package.json` and `centraid-city/bun.lock` own the dependency graph.
- Clear the GitHub bot's accessibility, correctness, and code-quality findings. — the targeted checks and SonarCloud analysis pass on the pushed PR head.
- Publish the city bundle at `/city/` and link it from the centraid.dev homepage navigation. — `scripts/docs-site/assemble.mjs`, `scripts/home-site/public/index.html`, and the site smoke assertions implement and verify this route.

Changed files:

- `.github/workflows/ci.yml`
- `centraid-city/README.md`
- `centraid-city/package.json`
- `centraid-city/vite.config.ts`
- `package.json`
- `scripts/docs-site/README.md`
- `scripts/docs-site/assemble.mjs`
- `scripts/docs-site/smoke.mjs`
- `scripts/home-site/public/index.html`

## Decisions

- Keep the package identity as `@centraid/city`; `centraid-city/` is its standalone package boundary and package-local lockfile.
- Build the hosted route with Vite's `/city/` base instead of rewriting generated HTML after the build. This keeps local development at `/` and makes asset URLs correct when copied into the combined Cloudflare site.
- Extend the existing docs-site assembly and smoke path so the city deploys with the same `centraid.dev` artifact; generated `dist/` output remains untracked.

## Out of scope

- No product code under `apps/` or `packages/` was changed or made dependent on the visualization.
- No Three.js source was vendored, and no generated city bundle was committed.
- No redesign of the landing page or docs navigation beyond the single `city` tab and the route needed to serve it.

## Verification

The package and hosted-site checks pass:

```bash
bun run --cwd centraid-city typecheck
bun run --cwd centraid-city build
bun run docs:bundle
DOCS_SITE_BASE_PATH=/docs bun run docs:smoke
bun run format:check
bun run lint
bun run check:push
```

`docs:smoke` reports 12 documentation pages with all internal links resolved and verifies the assembled homepage tab, `/city/index.html`, and `/city/assets/` script base. Vite's existing informational chunk-size warning remains non-fatal.

## Audit

PASS — the current site-integration diff is limited to the nine changed files named above; the package-local build, assembled-site smoke checks, formatting, lint, and all 31 push gates were rerun after the changes.

## Steering

**PASS**

The user explicitly redirected this PR to keep the package named `city` and expose its HTML as a tab on `centraid.dev`. This follow-up records that scope extension; it does not broaden the work into product integration or a landing-page redesign.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fc6ca-ba4-1785751677-1 | codex | 019fc6ca-ba44-7151-99a6-274b6252e406 | #706 | gpt-5.6-luna | 1153275 | 0 | 40032512 | 144507 | 1297782 | 15.0589 | 1153275 | 0 | 40032512 | 144507 | refactor(city): migrate city sources to TypeScript (#706) |
| codex-019fc6ca-ba4-1785751800-1 | codex | 019fc6ca-ba44-7151-99a6-274b6252e406 | #706 | gpt-5.6-luna | 9698 | 0 | 359680 | 2304 | 12002 | 0.1487 | 1162973 | 0 | 40392192 | 146811 | refactor(city): migrate city sources to TypeScript (#706) |
| codex-019fc6ca-ba4-1785751870-1 | codex | 019fc6ca-ba44-7151-99a6-274b6252e406 | #706 | gpt-5.6-luna | 13216 | 0 | 119296 | 567 | 13783 | 0.0714 | 1176189 | 0 | 40511488 | 147378 | refactor(city): migrate city sources to TypeScript (#706) -m governance: allow-t |
| codex-019fc6ca-ba4-1785753858-1 | codex | 019fc6ca-ba44-7151-99a6-274b6252e406 | #706 | gpt-5.6-luna | 399304 | 0 | 11126528 | 31751 | 431055 | 4.2562 | 1575493 | 0 | 51638016 | 179129 | fix(city): address SonarCloud findings (#706) |
| codex-019fc6ca-ba4-1785754639-1 | codex | 019fc6ca-ba44-7151-99a6-274b6252e406 | #706 | gpt-5.6-luna | 135857 | 0 | 3151616 | 18364 | 154221 | 1.4030 | 1711350 | 0 | 54789632 | 197493 | feat(site): publish city on centraid.dev (#706) |
| codex-019fc6ca-ba4-1785754735-1 | codex | 019fc6ca-ba44-7151-99a6-274b6252e406 | #706 | gpt-5.6-luna | 24924 | 0 | 795136 | 2976 | 27900 | 0.3057 | 1736274 | 0 | 55584768 | 200469 | feat(site): publish city on centraid.dev (#706) |
| codex-019fc6ca-ba4-1785754818-1 | codex | 019fc6ca-ba44-7151-99a6-274b6252e406 | #706 | gpt-5.6-luna | 11995 | 0 | 1025280 | 1753 | 13748 | 0.3126 | 1748269 | 0 | 56610048 | 202222 | feat(site): publish city on centraid.dev (#706) |
| codex-019fc6ca-ba4-1785754889-1 | codex | 019fc6ca-ba44-7151-99a6-274b6252e406 | #706 | gpt-5.6-luna | 3749 | 0 | 448768 | 407 | 4156 | 0.1277 | 1752018 | 0 | 57058816 | 202629 | feat(site): publish city on centraid.dev (#706) -m governance: allow-toolchain-c |
