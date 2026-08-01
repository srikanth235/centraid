# issue-672 — one token contract, semantic text roles, and legible themes
<!-- governance: allow-receipt-per-issue broad-token-migration -->

GitHub issue: [#672](https://github.com/srikanth235/centraid/issues/672)

## Checklist

- [x] Replace numbered ink tokens with semantic text roles across shell, blueprints, and mobile
- [x] Raise light-theme contrast, accent-as-text, borders, shadows, and dark ghost-text floor
- [x] Establish emitter contracts and executable shell/app-surface contrast floors
- [x] Remove density and the kit compatibility shim
- [x] Remove client CSS literals and tighten the token debt budget to the intentional app-identity exceptions
- [x] Regenerate mobile tokens with the teal hue and retire stale brand/wall assets

## What changed

- Replace numbered ink tokens with semantic text roles across shell, blueprints, and mobile.
- Raise light-theme contrast, accent-as-text, borders, shadows, and dark ghost-text floor.
- Establish emitter contracts and executable shell/app-surface contrast floors.
- Remove density and the kit compatibility shim.
- Remove client CSS literals and tighten the token debt budget to the intentional app-identity exceptions.
- Regenerate mobile tokens with the teal hue and retire stale brand/wall assets.

`@centraid/design-tokens` now owns one semantic vocabulary: `--text`,
`--text-soft`, `--text-faint`, `--text-ghost`, and `--text-inv` replace the
ambiguous ink rungs, replacing numbered ink tokens with semantic text roles
across shell, blueprints, and mobile. The shell and portable blueprint emitters
have explicit contracts, while contrast tests establish emitter contracts and
executable shell/app-surface contrast floors for text, accent, success, and
danger values against the surfaces where they render.

The light theme now uses a strong near-black text ramp, visible hairlines, and
an accessible teal text accent, raising light-theme contrast, accent-as-text,
borders, shadows, and the dark ghost-text floor. Blueprint defaults move to
the brand-teal hue; the mobile theme is regenerated from that source and uses
the same role names, retiring stale brand/wall assets.

Density is no longer a preference or CSS emission path. The blueprint kit now
consumes public contract tokens directly, without `--kit-*` aliases or literal
fallback colors, removing density and the kit compatibility shim. Client CSS
no longer carries raw colors or literal font stacks, removing client CSS
literals and tightening the token debt budget to the intentional app-identity
exceptions.

## Decisions

- Text roles describe purpose rather than brightness, so call sites cannot
  accidentally choose an illegible rung for real prose.
- A fixed spacing system replaces density variants: one interface layout is
  easier to scan, test, and keep in parity across hosts.
- Per-blueprint identity colors remain intentional and are the sole budgeted
  raw CSS colors; shell and shared-kit colors are contract-owned.

## Out of scope

- Changing individual blueprint identity palettes beyond migrating the shared
  vocabulary they consume.
- Redesigning product flows or adding new animation beyond existing behavior.

## Verification

```sh
bun run check:fast
bun run --cwd packages/design-tokens test
NODE_PATH=$PWD/node_modules bun run --cwd apps/mobile test -- src/kit/theme/generate.test.ts src/kit/theme/resolve.test.ts
node scripts/lint-design-tokens.mjs
```

`check:fast`, the semantic-token suite, focused mobile theme tests, and the
literal-token boundary lint passed locally. The desktop Electron smoke build
completed; the live renderer did not reach its readiness selector in this
headless session, so visual regression remains covered by the PR’s automated
desktop Playwright lane.

## Audit

Verdict: PASS. The issue’s token-contract, contrast, density-removal, brand
purge, client literal-tokenization, and mobile-regeneration requirements are
represented in the staged diff, with executable contract and contrast tests.

## Steering

PASS — Evidence: the operator asked the agent to create a PR containing all
current changes after the initial commit-hook status check; this redirected the
handoff from diagnosis to completing the governed commit and draft PR.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fbc6b-05b-1785574158-1 | codex | 019fbc6b-05bf-72d1-9acd-c246218b38eb | #672 | gpt-5.6-terra | 376206 | 0 | 16264192 | 46829 | 423035 | 5.7090 | 376206 | 0 | 16264192 | 46829 | feat(theme): unify token contract and improve legibility (#672) |
| codex-019fbc6b-05b-1785574807-1 | codex | 019fbc6b-05bf-72d1-9acd-c246218b38eb | #672 | gpt-5.6-terra | 19839 | 0 | 1886464 | 3251 | 23090 | 0.5700 | 396045 | 0 | 18150656 | 50080 | feat(theme): unify token contract and improve legibility (#672) |
| codex-019fbc6b-05b-1785574869-1 | codex | 019fbc6b-05bf-72d1-9acd-c246218b38eb | #672 | gpt-5.6-terra | 12053 | 0 | 321792 | 1416 | 13469 | 0.1318 | 408098 | 0 | 18472448 | 51496 | feat(theme): unify token contract and improve legibility (#672) |
| codex-019fbc6b-05b-1785574961-1 | codex | 019fbc6b-05bf-72d1-9acd-c246218b38eb | #672 | gpt-5.6-terra | 19779 | 0 | 993280 | 1306 | 21085 | 0.3174 | 427877 | 0 | 19465728 | 52802 | feat(theme): unify token contract and improve legibility (#672) |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
